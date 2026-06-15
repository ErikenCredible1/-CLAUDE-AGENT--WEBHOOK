# LINE AI Agent

A Manus-style AI agent you chat with on LINE. It can search the web, run code,
make API calls, read/write files, send emails, manage Google Calendar, Drive, and Sheets.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Fill in your `.env`:
- `LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN` — from [developers.line.biz](https://developers.line.biz)
- `OPENROUTER_API_KEY` — from [openrouter.ai](https://openrouter.ai)
- `TAVILY_API_KEY` *(optional but recommended)* — from [tavily.com](https://tavily.com) for better web search

### 3. Set up Google OAuth (for Gmail, Drive, Calendar, Sheets)

#### Step 1 — Create OAuth credentials
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or select an existing one)
3. Enable these APIs: Gmail API, Google Drive API, Google Calendar API, Google Sheets API
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Add `https://developers.google.com/oauthplayground` as an Authorized Redirect URI
7. Copy your **Client ID** and **Client Secret** into `.env`

#### Step 2 — Generate a refresh token
1. Open [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
2. Click the gear icon ⚙️ (top right) → check **Use your own OAuth credentials** → paste your Client ID and Client Secret
3. In Step 1, select these scopes:
   - `https://mail.google.com/` (Gmail full access)
   - `https://www.googleapis.com/auth/drive` (Drive)
   - `https://www.googleapis.com/auth/calendar` (Calendar)
   - `https://www.googleapis.com/auth/spreadsheets` (Sheets)
4. Click **Authorize APIs** → sign in with your Google account → Allow
5. Click **Exchange authorization code for tokens**
6. Copy the **Refresh token** into `.env` as `GOOGLE_REFRESH_TOKEN`

#### Important notes
- Keep your OAuth consent screen in **Production** mode (not Testing) to prevent refresh tokens expiring after 7 days
- If you get an `invalid_grant` error, your refresh token has expired — generate a new one at OAuth Playground
- The `/google-test` endpoint (e.g. `https://your-app.onrender.com/google-test`) lets you verify all Google services are connected

### 4. Run
```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### 5. Expose to the internet (dev)
```bash
ngrok http 3000
```
Set the ngrok HTTPS URL as your LINE webhook: `https://xxxx.ngrok.io/webhook`

---

## Project Structure

```
line-agent/
├── src/
│   ├── server.js       # Express + LINE webhook handler
│   ├── agent.js        # OpenRouter agentic loop
│   ├── tools.js        # Core tool definitions + implementations
│   ├── google.js       # Google OAuth2 auth client
│   ├── google-tools.js # Gmail, Drive, Calendar, Sheets tools
│   ├── memory.js       # Conversation history + persistent facts
│   ├── scheduler.js    # QStash-based scheduled tasks
│   └── alerts.js       # Price alert logic
├── workspace/          # Files the agent reads/writes
├── .env.example
└── package.json
```

---

## Available Tools

| Tool | What it does |
|---|---|
| `web_search` | Searches the web (Tavily or DuckDuckGo fallback) |
| `http_request` | Makes GET/POST requests to any API |
| `run_js` | Runs Node.js code (calculations, processing) |
| `read_file` | Reads a file from `/workspace` |
| `write_file` | Writes a file to `/workspace` |
| `list_files` | Lists files in `/workspace` |
| `get_stock_price` | Real-time stock prices |
| `get_crypto_price` | Real-time crypto prices |
| `set_price_alert` | Alerts when stock/crypto hits target price |
| `create_pdf` | Generates a PDF and uploads to Drive |
| `send_email` | Sends email via Gmail |
| `read_emails` | Searches Gmail inbox |
| `upload_to_drive` | Uploads file to Google Drive |
| `list_drive_files` | Lists files in Google Drive |
| `read_drive_file` | Reads content from a Drive file |
| `create_calendar_event` | Creates a Google Calendar event |
| `read_calendar` | Lists upcoming calendar events |
| `create_sheet` | Creates a Google Sheet with data |
| `remember` | Saves a persistent fact about the user |
| `recall` | Lists all saved facts |
| `forget_fact` | Deletes a saved fact |

---

## Switching Models

Change `OPENROUTER_MODEL` in `.env` to any model on OpenRouter:
- `anthropic/claude-sonnet-4-5` (default, best tool use)
- `openai/gpt-4o`
- `google/gemini-pro-1.5`

---

## Production Notes

- **Sandbox code execution**: `run_js` uses `execSync` — replace with
  [isolated-vm](https://github.com/laverdet/isolated-vm) or [E2B](https://e2b.dev) before exposing to others
- **Rate limiting**: Add per-user rate limiting if multiple people use the bot
- **Google tokens**: If deploying to Render, add all `GOOGLE_*` env vars in the Render dashboard under Environment
