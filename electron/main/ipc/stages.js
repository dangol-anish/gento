const { ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
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
  ipcMain.handle("open-path", async (_event, payload) => {
    if (!payload || typeof payload !== "object" || typeof payload.path !== "string") {
      return createError(ErrorCodes.INVALID_REQUEST, "path is required for open-path.");
    }

    const resolvedPath = path.resolve(process.cwd(), payload.path);
    try {
      const errorMessage = await shell.openPath(resolvedPath);
      if (errorMessage) {
        return createError(ErrorCodes.STAGE_EXECUTION_FAILED, "Failed to open requested path.", {
          path: resolvedPath,
          reason: errorMessage,
        });
      }
      return createSuccess({ path: resolvedPath });
    } catch (error) {
      return toUnknownError(error);
    }
  });

  ipcMain.handle("scrape-manga", async (_event, payload) => {
    if (!payload || typeof payload !== "object" || typeof payload.url !== "string") {
      return createError(ErrorCodes.INVALID_REQUEST, "url is required for scrape-manga.");
    }

    const outDir = payload.outDir || "./downloads";
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const args = ["-m", "scripts.downloader.scraper", "--url", payload.url, "--out", outDir, "--details-only"];

    try {
      const result = await runPythonCommand(pythonCmd, args);
      if (!result.ok) {
        return result;
      }

      const completeEvent = result.data.events.find((evt) => evt.type === "complete");
      if (!completeEvent) {
        return createError(ErrorCodes.STAGE_EXECUTION_FAILED, "Scrape completed without complete event.");
      }

      return createSuccess({
        manga_metadata: completeEvent.manga_metadata || {},
        chapters: completeEvent.chapters || [],
      });
    } catch (error) {
      return toUnknownError(error);
    }
  });

  ipcMain.handle("run-stage", async (_event, payload) => {
    const validationError = validateRunStagePayload(payload);
    if (validationError) {
      return validationError;
    }

    const { stage, args } = payload;

    try {
      if (stage === 0) {
        const pythonCmd = process.platform === "win32" ? "python" : "python3";
        const runResult = await runPythonCommand(pythonCmd, ["-m", "scripts.downloader.scraper", ...args]);
        return runResult;
      }

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

function runPythonCommand(command, commandArgs) {
  return new Promise((resolve) => {
    const proc = spawn(command, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
    });

    let stderr = "";
    const events = [];

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          events.push(parsed);
        } catch (_) {
          // Ignore non-JSON lines from python stage stdout.
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(createSuccess({ events }));
        return;
      }
      resolve(
        createError(ErrorCodes.PROCESS_EXIT_NON_ZERO, "Python stage exited with a non-zero code.", {
          exitCode: code,
          stderr: stderr || null,
          events,
        }),
      );
    });

    proc.on("error", (error) => {
      resolve(
        createError(ErrorCodes.PROCESS_SPAWN_FAILED, "Failed to spawn Python process.", {
          message: error.message,
        }),
      );
    });
  });
}

module.exports = {
  registerStageIpcHandlers,
};
