const { contextBridge, ipcRenderer } = require("electron");

function isValidResponseEnvelope(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const requiredFields = ["ok", "data", "error"];
  const hasAll = requiredFields.every((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (!hasAll) {
    return false;
  }

  if (typeof payload.ok !== "boolean") {
    return false;
  }

  if (payload.ok) {
    return payload.error === null;
  }

  return payload.data === null && payload.error && typeof payload.error === "object";
}

function normalizeResult(result) {
  if (isValidResponseEnvelope(result)) {
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
  scrapeManga(url, outDir = "./downloads") {
    return ipcRenderer
      .invoke("scrape-manga", { url, outDir })
      .then((result) => normalizeResult(result));
  },
  openPath(path) {
    return ipcRenderer.invoke("open-path", { path }).then((result) => normalizeResult(result));
  },
  onStageEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("stage-event", listener);
    return () => ipcRenderer.removeListener("stage-event", listener);
  },
});
