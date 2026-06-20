// Downloads the pinned Lightpanda browser binary at install time (build step,
// not runtime) -- avoids the same "fetch over the network on every cold boot"
// reliability problem already hit and fixed for the other MCP servers.
// Lightpanda is a from-scratch browser engine (not a Chromium wrapper): ~120MB
// peak memory for 100 pages vs. Chrome's ~2GB for the same load, which is what
// makes real interactive browser automation (click, fill forms) viable at all
// on Render's free tier. It's Beta software per its own docs -- failures here
// must never break `npm install` for the rest of the app.
const fs = require("fs");
const path = require("path");
const https = require("https");

const VERSION = "0.3.2";
const BIN_DIR = path.join(__dirname, "../bin");
const BIN_PATH = path.join(BIN_DIR, "lightpanda");

const ASSET_BY_PLATFORM = {
  "linux-x64": "lightpanda-x86_64-linux",
  "linux-arm64": "lightpanda-aarch64-linux",
  "darwin-x64": "lightpanda-x86_64-macos",
  "darwin-arm64": "lightpanda-aarch64-macos",
};

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          return download(res.headers.location, destPath).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        file.close();
        fs.rmSync(destPath, { force: true });
        reject(err);
      });
  });
}

async function main() {
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSET_BY_PLATFORM[key];
  if (!asset) {
    console.warn(`[lightpanda] No prebuilt binary for ${key} -- skipping (browser automation tool will be unavailable)`);
    return;
  }

  if (fs.existsSync(BIN_PATH)) {
    console.log("[lightpanda] Already downloaded, skipping");
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const url = `https://github.com/lightpanda-io/browser/releases/download/${VERSION}/${asset}`;
  console.log(`[lightpanda] Downloading ${asset} (v${VERSION})...`);

  try {
    await download(url, BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o755);
    console.log("[lightpanda] Ready");
  } catch (err) {
    console.warn(`[lightpanda] Download failed: ${err.message} -- continuing without it`);
    fs.rmSync(BIN_PATH, { force: true });
  }
}

main();
