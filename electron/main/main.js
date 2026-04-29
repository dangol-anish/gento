const { app, BrowserWindow } = require("electron");
const { createMainWindow } = require("./window");
const { registerStageIpcHandlers } = require("./ipc/stages");
const { registerLogIpcHandlers } = require("./ipc/logs");
const { writeErrorLog } = require("./logging/errorLogs");

function bootstrap() {
  registerStageIpcHandlers();
  registerLogIpcHandlers();
  createMainWindow();
}

app.whenReady().then(() => {
  bootstrap();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

process.on("uncaughtException", (error) => {
  writeErrorLog({ error, context: { source: "main", kind: "uncaughtException" } }).catch(() => {});
});

process.on("unhandledRejection", (reason) => {
  writeErrorLog({
    error: reason instanceof Error ? reason : new Error(String(reason)),
    context: { source: "main", kind: "unhandledRejection", reason },
  }).catch(() => {});
});
