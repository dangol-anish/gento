const { ipcMain } = require("electron");
const {
  ErrorCodes,
  createSuccess,
  createError,
  toUnknownError,
} = require("./contracts");

function validateRunStagePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return createError(
      ErrorCodes.INVALID_REQUEST,
      "Payload must be an object with stage and args.",
    );
  }

  const { stage, args } = payload;
  if (!Number.isInteger(stage) || stage < 0) {
    return createError(
      ErrorCodes.INVALID_STAGE,
      "stage must be a non-negative integer.",
      { receivedStage: stage },
    );
  }

  if (!Array.isArray(args)) {
    return createError(
      ErrorCodes.INVALID_REQUEST,
      "args must be an array.",
      { receivedArgsType: typeof args },
    );
  }

  return null;
}

/**
 * Registers IPC channels used by the renderer.
 * Stage execution is stubbed for now and will be replaced
 * with Python process orchestration in the next step.
 */
function registerStageIpcHandlers() {
  ipcMain.handle("run-stage", async (_event, payload) => {
    const validationError = validateRunStagePayload(payload);
    if (validationError) {
      return validationError;
    }

    const { stage, args } = payload;

    try {
      return createSuccess({
        stage,
        args,
        message: "Stage handler scaffold is connected.",
      });
    } catch (error) {
      return createError(
        ErrorCodes.STAGE_EXECUTION_FAILED,
        "Stage execution failed.",
        toUnknownError(error).error,
      );
    }
  });
}

module.exports = {
  registerStageIpcHandlers,
};
