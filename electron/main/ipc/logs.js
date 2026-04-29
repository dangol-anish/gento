const { ipcMain, shell } = require("electron");
const { createError, createSuccess, ErrorCodes } = require("./contracts");
const { getErrorLogsDir, writeErrorLog } = require("../logging/errorLogs");

function registerLogIpcHandlers() {
  ipcMain.handle("report-renderer-error", async (_event, payload) => {
    try {
      const { error, context } = payload ?? {};
      const result = await writeErrorLog({
        error: error ?? "Unknown renderer error",
        context: { source: "renderer", ...(context ?? {}) },
      });
      return createSuccess({ logId: result.logId });
    } catch (error) {
      return createError(
        ErrorCodes.INTERNAL_ERROR,
        error?.message || "Failed to write error log",
      );
    }
  });

  ipcMain.handle("get-error-logs-dir", async () => {
    try {
      const dir = await getErrorLogsDir();
      return createSuccess({ dir });
    } catch (error) {
      return createError(
        ErrorCodes.INTERNAL_ERROR,
        error?.message || "Failed to resolve logs directory",
      );
    }
  });

  ipcMain.handle("open-error-logs-dir", async () => {
    try {
      const dir = await getErrorLogsDir();
      const errorMessage = await shell.openPath(dir);
      if (errorMessage) {
        return createError(ErrorCodes.INTERNAL_ERROR, errorMessage, { dir });
      }
      return createSuccess({ dir });
    } catch (error) {
      return createError(
        ErrorCodes.INTERNAL_ERROR,
        error?.message || "Failed to open logs directory",
      );
    }
  });
}

module.exports = { registerLogIpcHandlers };

