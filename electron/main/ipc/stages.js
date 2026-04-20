const { ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const https = require("https");
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
function sendStageEvent(event, payload) {
  try {
    event.sender.send("stage-event", payload);
  } catch {
    // Ignore failures while sending progress events.
  }
}

function parseFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  return typeof value === "string" ? value : null;
}

function isLocalOllamaHost(host) {
  try {
    const url = new URL(host);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      parsed,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve({ status: res.statusCode || 0, data });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("error", (error) => reject(error));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.end();
  });
}

async function waitForOllama(host, timeoutMs = 8000) {
  const url = host.replace(/\/+$/, "") + "/api/tags";
  const start = Date.now();
  // Poll quickly for a short period; Ollama may need a moment to start listening.
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await httpGetJson(url, 1200);
      if (result && typeof result.status === "number" && result.status >= 200 && result.status < 500) {
        return true;
      }
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ensureOllamaRunning(host, ipcEvent, stage) {
  if (!isLocalOllamaHost(host)) {
    // For remote hosts, we never try to start the server.
    const ok = await waitForOllama(host, 1500);
    if (!ok && ipcEvent) {
      sendStageEvent(ipcEvent, {
        type: "log",
        stage,
        message: `Ollama is not reachable at ${host}. Start it (or fix host) and try again.`,
      });
    }
    return ok;
  }

  const reachable = await waitForOllama(host, 1200);
  if (reachable) {
    if (ipcEvent) {
      sendStageEvent(ipcEvent, { type: "log", stage, message: `Ollama is reachable at ${host}.` });
    }
    return true;
  }

  if (ipcEvent) {
    sendStageEvent(ipcEvent, { type: "log", stage, message: "Ollama not running; attempting to start `ollama serve`..." });
  }

  try {
    // Quick sanity check (useful to debug missing PATH in packaged apps).
    try {
      const versionProbe = spawn("ollama", ["--version"], { stdio: "pipe" });
      let out = "";
      versionProbe.stdout?.on("data", (chunk) => {
        out += chunk.toString();
      });
      versionProbe.on("close", (code) => {
        if (ipcEvent) {
          sendStageEvent(ipcEvent, {
            type: "log",
            stage,
            message: `Ollama probe exited ${code}: ${(out || "").trim() || "(no stdout)"}`,
          });
        }
      });
      versionProbe.on("error", (error) => {
        if (ipcEvent) {
          sendStageEvent(ipcEvent, {
            type: "log",
            stage,
            message: `Ollama probe failed: ${error?.message || String(error)}`,
          });
        }
      });
    } catch {
      // ignore probe issues; attempt serve anyway
    }

    const proc = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    proc.unref();
  } catch (error) {
    if (ipcEvent) {
      sendStageEvent(ipcEvent, {
        type: "log",
        stage,
        message: `Failed to spawn 'ollama serve': ${error?.message || String(error)}`,
      });
    }
    return false;
  }

  const ok = await waitForOllama(host, 8000);
  if (!ok && ipcEvent) {
    sendStageEvent(ipcEvent, {
      type: "log",
      stage,
      message: `Ollama did not become ready at ${host}. Make sure Ollama is installed and running.`,
    });
  }
  return ok;
}

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
    console.log(`[run-stage] starting stage ${stage} with args: ${JSON.stringify(args)}`);

    try {
      if (stage === 0) {
        const pythonCmd = process.platform === "win32" ? "python" : "python3";
        const runResult = await runPythonCommand(
          pythonCmd,
          ["-m", "scripts.downloader.scraper", ...args],
          _event,
          stage,
        );
        return runResult;
      }

      if (stage === 1) {
        const pythonCmd = process.platform === "win32" ? "python" : "python3";
        const runResult = await runPythonCommand(pythonCmd, ["-m", "scripts.extract_chapter", ...args], _event, stage);
        return runResult;
      }

      if (stage === 2) {
        const pythonCmd = process.platform === "win32" ? "python" : "python3";
        const sceneProvider = parseFlagValue(args, "--scene-provider");
        const ollamaHost = parseFlagValue(args, "--ollama-host") || "http://127.0.0.1:11434";
        if (_event) {
          sendStageEvent(_event, {
            type: "log",
            stage: 2,
            message: `Stage 2 preflight: provider=${sceneProvider || "(missing)"} host=${ollamaHost}`,
          });
        }
        if (sceneProvider === "ollama") {
          const ready = await ensureOllamaRunning(ollamaHost, _event, 2);
          if (!ready) {
            return createError(
              ErrorCodes.STAGE_EXECUTION_FAILED,
              "Ollama is not running or reachable.",
              { host: ollamaHost },
            );
          }
        }
        const runResult = await runPythonCommand(pythonCmd, ["-m", "scripts.add_scenes", ...args], _event, stage);
        return runResult;
      }

      if (stage === 3) {
        const pythonCmd = process.platform === "win32" ? "python" : "python3";
        const ollamaHost = parseFlagValue(args, "--ollama-host") || "http://127.0.0.1:11434";
        if (_event) {
          sendStageEvent(_event, {
            type: "log",
            stage: 3,
            message: `Stage 3 preflight: host=${ollamaHost}`,
          });
        }
        const ready = await ensureOllamaRunning(ollamaHost, _event, 3);
        if (!ready) {
          return createError(
            ErrorCodes.STAGE_EXECUTION_FAILED,
            "Ollama is not running or reachable.",
            { host: ollamaHost },
          );
        }
        const runResult = await runPythonCommand(pythonCmd, ["-m", "scripts.make_panel_recaps", ...args], _event, stage);
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

function runPythonCommand(command, commandArgs, ipcEvent, stageHint = null) {
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
        console.log(`[run-stage] python stdout: ${line}`);
        try {
          const parsed = JSON.parse(line);
          events.push(parsed);
          if (ipcEvent) {
            sendStageEvent(ipcEvent, parsed);
          }
        } catch (_) {
          if (ipcEvent) {
            sendStageEvent(ipcEvent, { type: "log", stage: stageHint, message: line });
          }
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        console.error(`[run-stage] python stderr: ${line}`);
        if (ipcEvent) {
          sendStageEvent(ipcEvent, { type: "log", stage: stageHint, message: line });
        }
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        if (typeof stageHint === "number") {
          const hasComplete = events.some(
            (evt) => evt && evt.type === "complete" && (typeof evt.stage !== "number" || evt.stage === stageHint),
          );
          if (!hasComplete) {
            resolve(
              createError(ErrorCodes.STAGE_EXECUTION_FAILED, "Stage completed without a complete event.", {
                stage: stageHint,
                stderr: stderr || null,
                events,
              }),
            );
            return;
          }
        }
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
