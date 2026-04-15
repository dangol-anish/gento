const { contextBridge, ipcRenderer } = require("electron");

function normalizeResult(result) {
  if (result && typeof result === "object" && "ok" in result) {
    return result;
  }

  return {
    ok: false,
    data: null,
    error: {
      code: "INTERNAL_ERROR",
      message: "Malformed IPC response.",
      details: { received: result },
    },
  };
}

contextBridge.exposeInMainWorld("gento", {
  runStage(stage, args = []) {
    return ipcRenderer
      .invoke("run-stage", { stage, args })
      .then((result) => normalizeResult(result));
  },
});
