const { BrowserWindow } = require("electron");
const path = require("path");

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
    window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  return window;
}

module.exports = {
  createMainWindow,
};
