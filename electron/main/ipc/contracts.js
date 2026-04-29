const fs = require("fs");
const path = require("path");
const { writeErrorLog } = require("../logging/errorLogs");

function loadErrorCodes() {
  const codesPath = path.join(__dirname, "..", "..", "..", "shared", "error-codes.json");
  try {
    const raw = fs.readFileSync(codesPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Object.freeze(parsed);
  } catch (_error) {
    return Object.freeze({
      INVALID_REQUEST: "INVALID_REQUEST",
      INVALID_STAGE: "INVALID_STAGE",
      STAGE_EXECUTION_FAILED: "STAGE_EXECUTION_FAILED",
      PROCESS_SPAWN_FAILED: "PROCESS_SPAWN_FAILED",
      PROCESS_EXIT_NON_ZERO: "PROCESS_EXIT_NON_ZERO",
      INTERNAL_ERROR: "INTERNAL_ERROR",
    });
  }
}

const ErrorCodes = loadErrorCodes();

function createSuccess(data) {
  return {
    ok: true,
    data,
    error: null,
  };
}

function createError(code, message, details = null) {
  return {
    ok: false,
    data: null,
    error: {
      code,
      message,
      details,
    },
  };
}

function toUnknownError(error, context = null) {
  const safeMessage = error instanceof Error ? error.message : "Unknown error";
  // Best-effort: logging should never break the original flow.
  Promise.resolve()
    .then(() => writeErrorLog({ error, context: context ?? { source: "ipc" } }))
    .catch(() => {});
  return createError(ErrorCodes.INTERNAL_ERROR, safeMessage);
}

module.exports = {
  ErrorCodes,
  createSuccess,
  createError,
  toUnknownError,
};
