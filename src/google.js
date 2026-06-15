const { google } = require("googleapis");

/**
 * Get an authenticated Google OAuth2 client using refresh token.
 * Creates a fresh client each call to avoid caching broken token state.
 */
function getAuth() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      "Google tools are not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in your .env file. See README for setup instructions."
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  oauth2Client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      console.log("[Google OAuth] Access token refreshed successfully");
    }
  });

  // Wrap the client so API errors from expired/revoked tokens surface clearly
  const originalRequest = oauth2Client.request.bind(oauth2Client);
  oauth2Client.request = async (opts) => {
    try {
      return await originalRequest(opts);
    } catch (err) {
      if (err.message?.includes("invalid_grant") || err.response?.data?.error === "invalid_grant") {
        throw new Error(
          "Google refresh token has expired or been revoked. Please generate a new one at https://developers.google.com/oauthplayground and update GOOGLE_REFRESH_TOKEN in your .env / Render environment variables."
        );
      }
      throw err;
    }
  };

  return oauth2Client;
}

function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

function getGmail() {
  return google.gmail({ version: "v1", auth: getAuth() });
}

function getCalendar() {
  return google.calendar({ version: "v3", auth: getAuth() });
}

function getSheets() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

module.exports = { getAuth, getDrive, getGmail, getCalendar, getSheets };
