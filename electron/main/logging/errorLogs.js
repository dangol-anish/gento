const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

function isoForFilename(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    };
  }
  return {
    name: "NonErrorThrown",
    message: typeof error === "string" ? error : "Non-Error thrown value",
    stack: null,
    cause: null,
    thrown: error,
  };
}

async function writeErrorLog({ error, context = {}, severity = "error" }) {
  const now = new Date();
  const logId = crypto.randomUUID();
  const overrideDir =
    typeof process.env.GENTO_ERROR_LOG_DIR === "string" && process.env.GENTO_ERROR_LOG_DIR.trim()
      ? process.env.GENTO_ERROR_LOG_DIR.trim()
      : null;
  const logsRoot = overrideDir ?? path.join(app.getPath("userData"), "logs", "errors");
  await ensureDir(logsRoot);

  const filename = `${isoForFilename(now)}_${logId}.log`;
  const filePath = path.join(logsRoot, filename);

  const payload = {
    id: logId,
    timestamp: now.toISOString(),
    severity,
    app: {
      name: app.getName(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    },
    platform: {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    context,
    error: serializeError(error),
  };

  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(filePath, body, { encoding: "utf-8" });

  return { logId, filePath };
}

async function getErrorLogsDir() {
  const overrideDir =
    typeof process.env.GENTO_ERROR_LOG_DIR === "string" && process.env.GENTO_ERROR_LOG_DIR.trim()
      ? process.env.GENTO_ERROR_LOG_DIR.trim()
      : null;
  return overrideDir ?? path.join(app.getPath("userData"), "logs", "errors");
}

module.exports = {
  writeErrorLog,
  getErrorLogsDir,
};
