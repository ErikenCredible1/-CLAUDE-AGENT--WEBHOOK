const fs = require("fs");
const path = require("path");

// Shared by tools.js (Telegram-uploaded files) and google-tools.js (Gmail
// attachments) so PDF/Word extraction isn't duplicated between them.
async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    // pdf-parse v2 replaced the old callable-function API with a PDFParse
    // class (new PDFParse({ data: buffer }).getText()) -- must call destroy()
    // after use to free memory.
    const { PDFParse } = require("pdf-parse");
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text.slice(0, 10000);
    } finally {
      await parser.destroy();
    }
  }

  if (ext === ".docx" || ext === ".doc") {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value.slice(0, 10000);
  }

  return fs.readFileSync(filePath, "utf8").slice(0, 10000);
}

module.exports = { extractTextFromFile };
