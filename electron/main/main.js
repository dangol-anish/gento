const { app } = require("electron");
const { createMainWindow } = require("./window");
const { registerStageIpcHandlers } = require("./ipc/stages");

function bootstrap() {
  registerStageIpcHandlers();
  createMainWindow();
}

app.whenReady().then(() => {
  bootstrap();

  app.on("activate", () => {
    if (app.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
