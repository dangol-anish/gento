const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { writeErrorLog } = require("./logging/errorLogs");

function createMainWindow() {
  const rendererUrl = process.env.GENTO_RENDERER_URL;
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (rendererUrl) {
    window.loadURL(rendererUrl);
  } else {
    const appRoot = app.isPackaged ? app.getAppPath() : process.cwd();
    const exportedIndex = path.join(appRoot, "renderer", "out", "index.html");
    const legacyIndex = path.join(__dirname, "..", "renderer", "index.html");
    window.loadFile(fs.existsSync(exportedIndex) ? exportedIndex : legacyIndex);
  }

  window.webContents.on("render-process-gone", (_event, details) => {
    writeErrorLog({
      error: new Error(`Renderer process gone: ${details.reason}`),
      context: { source: "main", kind: "render-process-gone", details },
    }).catch(() => {});
  });

  window.webContents.on("unresponsive", () => {
    writeErrorLog({
      error: new Error("Renderer became unresponsive"),
      context: { source: "main", kind: "renderer-unresponsive" },
    }).catch(() => {});
  });

  return window;
}

module.exports = {
  createMainWindow,
};
