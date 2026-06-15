const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { getDrive, getGmail, getCalendar, getSheets } = require("./google");

const WORK_DIR = path.join(__dirname, "../workspace");

// ─── Google tool definitions ──────────────────────────────────────────────────

const GOOGLE_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email from the agent's Gmail account.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body (plain text)" },
          attachment_filename: { type: "string", description: "Optional filename from workspace to attach" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_emails",
      description: "Read and search emails from the agent's Gmail inbox.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query e.g. 'from:john@example.com' or 'subject:invoice' or 'is:unread'" },
          max_results: { type: "number", description: "Max number of emails to return (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upload_to_drive",
      description: "Upload a file from the workspace to Google Drive and return a shareable link.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename in the workspace to upload" },
          drive_folder_name: { type: "string", description: "Optional Drive folder name to upload to (default: Agent Files)" },
        },
        required: ["filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_drive_files",
      description: "List files in the agent's Google Drive.",
      parameters: {
        type: "object",
        properties: {
          folder_name: { type: "string", description: "Optional folder name to list files in" },
          max_results: { type: "number", description: "Max number of files to return (default 10)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_drive_file",
      description: "Read and extract text content from a file in Google Drive.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Name of the file in Google Drive" },
        },
        required: ["filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Create an event in the agent's Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title" },
          start: { type: "string", description: "Start datetime in ISO format e.g. 2026-06-15T10:00:00" },
          end: { type: "string", description: "End datetime in ISO format e.g. 2026-06-15T11:00:00" },
          description: { type: "string", description: "Optional event description" },
          attendees: { type: "array", items: { type: "string" }, description: "Optional list of attendee email addresses" },
        },
        required: ["title", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_calendar",
      description: "Read upcoming events from the agent's Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          days_ahead: { type: "number", description: "How many days ahead to look (default 7)" },
          max_results: { type: "number", description: "Max events to return (default 10)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_sheet",
      description: "Create a Google Sheet with data and return a shareable link.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Spreadsheet title" },
          headers: { type: "array", items: { type: "string" }, description: "Column headers" },
          rows: { type: "array", items: { type: "array" }, description: "Array of rows, each row is an array of values" },
        },
        required: ["title", "headers", "rows"],
      },
    },
  },
];

// ─── Google tool implementations ──────────────────────────────────────────────

async function executeGoogleTool(name, args) {
  switch (name) {
    case "send_email":          return await sendEmail(args);
    case "read_emails":         return await readEmails(args);
    case "upload_to_drive":     return await uploadToDrive(args);
    case "list_drive_files":    return await listDriveFiles(args);
    case "read_drive_file":     return await readDriveFile(args);
    case "create_calendar_event": return await createCalendarEvent(args);
    case "read_calendar":       return await readCalendar(args);
    case "create_sheet":        return await createSheet(args);
    default: return null; // not a Google tool
  }
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, body, attachment_filename }) {
  const gmail = getGmail();

  let messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
  ];

  if (attachment_filename) {
    const safeName = path.basename(attachment_filename);
    const filePath = path.join(WORK_DIR, safeName);

    if (!fs.existsSync(filePath)) {
      return `File not found in workspace: ${safeName}`;
    }

    const fileContent = fs.readFileSync(filePath).toString("base64");
    const boundary = "boundary_line_agent";

    messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body,
      ``,
      `--${boundary}`,
      `Content-Type: application/octet-stream`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${safeName}"`,
      ``,
      fileContent,
      `--${boundary}--`,
    ];
  } else {
    messageParts.push(`Content-Type: text/plain; charset=utf-8`, ``, body);
  }

  const message = messageParts.join("\n");
  const encoded = Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });

  return `Email sent to ${to} with subject "${subject}"${attachment_filename ? ` and attachment ${attachment_filename}` : ""}`;
}

async function readEmails({ query, max_results = 5 }) {
  const gmail = getGmail();

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: max_results,
  });

  const messages = listRes.data.messages || [];
  if (!messages.length) return "No emails found matching that query.";

  const results = [];
  for (const msg of messages.slice(0, max_results)) {
    const detail = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
    const headers = detail.data.payload.headers;
    const from = headers.find((h) => h.name === "From")?.value || "Unknown";
    const subject = headers.find((h) => h.name === "Subject")?.value || "No subject";
    const date = headers.find((h) => h.name === "Date")?.value || "";
    const snippet = detail.data.snippet || "";
    results.push(`From: ${from}\nDate: ${date}\nSubject: ${subject}\nPreview: ${snippet}`);
  }

  return results.join("\n\n---\n\n");
}

// ── Google Drive ──────────────────────────────────────────────────────────────

async function getFolderId(drive, folderName = "Agent Files") {
  const res = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
  });
  return res.data.files?.[0]?.id || null;
}

async function uploadToDrive({ filename, drive_folder_name = "Agent Files" }) {
  const drive = getDrive();
  const safeName = path.basename(filename);
  const filePath = path.join(WORK_DIR, safeName);

  if (!fs.existsSync(filePath)) return `File not found in workspace: ${safeName}`;

  // Upload without specifying parent first
  const media = {
    mimeType: getMimeType(safeName),
    body: fs.createReadStream(filePath),
  };

  const uploaded = await drive.files.create({
    requestBody: { name: safeName },
    media,
    fields: "id, name, webViewLink, parents",
  });

  // Move to Agent Files folder
  try {
    const folderId = await getFolderId(drive, drive_folder_name);
    if (folderId) {
      const prevParents = (uploaded.data.parents || []).join(",");
      await drive.files.update({
        fileId: uploaded.data.id,
        addParents: folderId,
        removeParents: prevParents,
        fields: "id, parents",
      });
    }
  } catch (err) {
    console.warn("Could not move file to folder:", err.message);
  }

  // Make shareable
  await drive.permissions.create({
    fileId: uploaded.data.id,
    requestBody: { role: "reader", type: "anyone" },
  });

  // Get updated link
  const fileInfo = await drive.files.get({
    fileId: uploaded.data.id,
    fields: "webViewLink",
  });

  return `Uploaded to Drive!\nFile: ${safeName}\nLink: ${fileInfo.data.webViewLink}`;
}

async function listDriveFiles({ folder_name, max_results = 10 }) {
  const drive = getDrive();
  let query = "trashed=false";

  if (folder_name) {
    const folderId = await getFolderId(drive, folder_name);
    if (folderId) query += ` and '${folderId}' in parents`;
  }

  const res = await drive.files.list({
    q: query,
    pageSize: max_results,
    fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
    orderBy: "modifiedTime desc",
  });

  const files = res.data.files || [];
  if (!files.length) return "No files found in Drive.";

  return files
    .map((f) => `${f.name}\nType: ${f.mimeType}\nModified: ${f.modifiedTime}\nLink: ${f.webViewLink}`)
    .join("\n\n---\n\n");
}

async function readDriveFile({ filename }) {
  const drive = getDrive();

  const res = await drive.files.list({
    q: `name='${filename}' and trashed=false`,
    fields: "files(id, name, mimeType)",
  });

  const file = res.data.files?.[0];
  if (!file) return `File "${filename}" not found in Drive.`;

  // Export Google Docs as plain text
  if (file.mimeType === "application/vnd.google-apps.document") {
    const exported = await drive.files.export({ fileId: file.id, mimeType: "text/plain" }, { responseType: "text" });
    return String(exported.data).slice(0, 10000);
  }

  // Export Google Sheets as CSV
  if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    const exported = await drive.files.export({ fileId: file.id, mimeType: "text/csv" }, { responseType: "text" });
    return String(exported.data).slice(0, 10000);
  }

  // Download other files
  const downloaded = await drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "arraybuffer" });
  const buffer = Buffer.from(downloaded.data);

  // Try to parse PDF
  if (file.mimeType === "application/pdf") {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    return data.text.slice(0, 10000);
  }

  // Plain text
  return buffer.toString("utf8").slice(0, 10000);
}

// ── Google Calendar ───────────────────────────────────────────────────────────

function getTimezone() {
  const offset = parseInt(process.env.TIMEZONE_OFFSET || "0", 10);
  // Map common UTC offsets to IANA timezone names for Google Calendar
  const tzMap = {
    "-12": "Etc/GMT+12", "-11": "Pacific/Midway", "-10": "Pacific/Honolulu",
    "-9": "America/Anchorage", "-8": "America/Los_Angeles", "-7": "America/Denver",
    "-6": "America/Chicago", "-5": "America/New_York", "-4": "America/Halifax",
    "-3": "America/Sao_Paulo", "-2": "Etc/GMT+2", "-1": "Atlantic/Azores",
    "0": "UTC", "1": "Europe/Paris", "2": "Europe/Helsinki",
    "3": "Europe/Moscow", "4": "Asia/Dubai", "5": "Asia/Karachi",
    "5.5": "Asia/Kolkata", "6": "Asia/Dhaka", "7": "Asia/Bangkok",
    "8": "Asia/Singapore", "9": "Asia/Tokyo", "9.5": "Australia/Darwin",
    "10": "Australia/Sydney", "11": "Pacific/Noumea", "12": "Pacific/Auckland",
  };
  return tzMap[String(offset)] || "UTC";
}

async function createCalendarEvent({ title, start, end, description, attendees }) {
  const calendar = getCalendar();
  const tz = getTimezone();

  const event = {
    summary: title,
    description: description || "",
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
    ...(attendees?.length && { attendees: attendees.map((email) => ({ email })) }),
  };

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: event,
  });

  return `Event created: "${title}"\nStart: ${start}\nEnd: ${end}\nLink: ${res.data.htmlLink}`;
}

async function readCalendar({ days_ahead = 7, max_results = 10 }) {
  const calendar = getCalendar();
  const now = new Date();
  const end = new Date(now.getTime() + days_ahead * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    maxResults: max_results,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = res.data.items || [];
  if (!events.length) return `No events in the next ${days_ahead} days.`;

  return events
    .map((e) => {
      const start = e.start.dateTime || e.start.date;
      return `${e.summary}\nWhen: ${start}${e.description ? `\nDetails: ${e.description}` : ""}`;
    })
    .join("\n\n---\n\n");
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

async function createSheet({ title, headers, rows }) {
  const sheets = getSheets();
  const drive = getDrive();

  // Create the spreadsheet
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{ properties: { title: "Sheet1" } }],
    },
  });

  const spreadsheetId = created.data.spreadsheetId;
  const values = [headers, ...rows];

  // Write data
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    requestBody: { values },
  });

  // Move to Agent Files folder if it exists
  try {
    const folderId = await getFolderId(drive, "Agent Files");
    if (folderId) {
      // Get current parents
      const file = await drive.files.get({
        fileId: spreadsheetId,
        fields: "parents",
      });
      const prevParents = (file.data.parents || []).join(",");

      // Move to Agent Files
      await drive.files.update({
        fileId: spreadsheetId,
        addParents: folderId,
        removeParents: prevParents,
        fields: "id, parents",
      });
    }
  } catch (err) {
    console.warn("Could not move sheet to Agent Files folder:", err.message);
  }

  // Make shareable
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: { role: "reader", type: "anyone" },
  });

  const link = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  return `Spreadsheet created: "${title}"\nLink: ${link}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".txt": "text/plain",
    ".csv": "text/csv",
  };
  return types[ext] || "application/octet-stream";
}

module.exports = { executeGoogleTool, GOOGLE_TOOL_DEFINITIONS };
