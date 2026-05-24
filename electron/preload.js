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
  listDownloadsLibrary(root = "./downloads") {
    return ipcRenderer
      .invoke("list-downloads-library", { root })
      .then((result) => normalizeResult(result));
  },
  getAppSettings() {
    return ipcRenderer.invoke("get-app-settings").then((result) => normalizeResult(result));
  },
  setAppSettings(patch) {
    return ipcRenderer.invoke("set-app-settings", patch).then((result) => normalizeResult(result));
  },
  importStage4FinalScript(recapPath, finalScriptJson) {
    return ipcRenderer
      .invoke("stage4-import-final-script", { recapPath, finalScriptJson })
      .then((result) => normalizeResult(result));
  },
  importStage4GeminiJson(outPath, geminiJson) {
    return ipcRenderer
      .invoke("stage4-import-gemini-json", { outPath, geminiJson })
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
  renumberPages(pathOrPaths) {
    const payload = Array.isArray(pathOrPaths)
      ? { paths: pathOrPaths }
      : { path: pathOrPaths };
    return ipcRenderer.invoke("renumber-pages", payload).then((result) => normalizeResult(result));
  },
  pathExists(path) {
    return ipcRenderer.invoke("path-exists", { path }).then((result) => normalizeResult(result));
  },
  onStageEvent(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("stage-event", listener);
    return () => ipcRenderer.removeListener("stage-event", listener);
  },
  reportError(error, context) {
    return ipcRenderer
      .invoke("report-renderer-error", { error, context })
      .then((result) => normalizeResult(result));
  },
  getErrorLogsDir() {
    return ipcRenderer.invoke("get-error-logs-dir").then((result) => normalizeResult(result));
  },
  openErrorLogsDir() {
    return ipcRenderer.invoke("open-error-logs-dir").then((result) => normalizeResult(result));
  },
});
