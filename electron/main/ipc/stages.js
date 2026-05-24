const { app, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const ffmpegStatic = require("ffmpeg-static");
const {
  ErrorCodes,
  createSuccess,
  createError,
  toUnknownError,
} = require("./contracts");
const { writeErrorLog } = require("../logging/errorLogs");

function redactSecrets(value, depth = 0) {
  if (depth > 6) {
    return "[Truncated]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSecrets(item, depth + 1));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (typeof key === "string" && /(api[-_ ]?key|token|secret|password)/i.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redactSecrets(inner, depth + 1);
  }
  return out;
}

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

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readAppSettings() {
  const settingsPath = getSettingsPath();
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAppSettings(settings) {
  const settingsPath = getSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function getProjectRoot() {
  return app.isPackaged ? process.resourcesPath : process.cwd();
}

function getUserWorkspaceDir() {
  if (!app.isPackaged) {
    return process.cwd();
  }
  const root = app.getPath("userData");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

function getVenvPythonPath() {
  const venvRoot = path.join(app.getPath("userData"), "python", "venv");
  if (process.platform === "win32") {
    return path.join(venvRoot, "Scripts", "python.exe");
  }
  return path.join(venvRoot, "bin", "python3");
}

function pickPythonCommand() {
  const venvPython = getVenvPythonPath();
  if (fs.existsSync(venvPython)) {
    return { command: venvPython, prefixArgs: [] };
  }

  const canRun = (command, args) => {
    const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
    return !result.error && result.status === 0;
  };

  if (process.platform === "win32") {
    const candidates = [
      { command: "py", prefixArgs: ["-3.12"] },
      { command: "py", prefixArgs: ["-3.11"] },
      { command: "py", prefixArgs: ["-3.10"] },
      { command: "py", prefixArgs: ["-3"] },
      { command: "python", prefixArgs: [] },
    ];

    for (const candidate of candidates) {
      if (canRun(candidate.command, [...candidate.prefixArgs, "-V"])) {
        return candidate;
      }
    }
    return { command: "python", prefixArgs: [] };
  }

  return { command: "python3", prefixArgs: [] };
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

const PAGE_FILE_REGEX = /^page_(\d+)\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

function listPageFiles(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Failed to read directory: ${error?.message || String(error)}`);
  }

  const pages = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = PAGE_FILE_REGEX.exec(entry.name);
    if (!match) continue;
    pages.push({
      name: entry.name,
      index: Number.parseInt(match[1], 10),
      ext: path.extname(entry.name),
    });
  }

  pages.sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    return a.name.localeCompare(b.name);
  });

  return pages;
}

function renumberPagesInDir(dirPath) {
  const pages = listPageFiles(dirPath);
  if (pages.length === 0) {
    return { renamedCount: 0, pageCount: 0 };
  }

  const tmpPrefix = `.gento_renumber_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tmpNames = new Map(); // original -> tmp
  const desiredNames = new Map(); // original -> desired

  pages.forEach((page, i) => {
    const desired = `page_${i + 1}${page.ext}`;
    desiredNames.set(page.name, desired);
    tmpNames.set(page.name, `${tmpPrefix}_${i + 1}${page.ext}`);
  });

  let renamedCount = 0;

  // First pass: move everything to temp names to avoid collisions.
  for (const page of pages) {
    const from = path.join(dirPath, page.name);
    const to = path.join(dirPath, tmpNames.get(page.name));
    if (from === to) continue;
    fs.renameSync(from, to);
  }

  // Second pass: move to final sequential names.
  for (const page of pages) {
    const tmp = path.join(dirPath, tmpNames.get(page.name));
    const desired = path.join(dirPath, desiredNames.get(page.name));
    if (path.basename(tmp) === path.basename(desired)) continue;
    fs.renameSync(tmp, desired);
    renamedCount += 1;
  }

  return { renamedCount, pageCount: pages.length };
}

function renumberPagesAtPath(targetPath) {
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    throw new Error("Path must be a directory.");
  }

  const direct = listPageFiles(targetPath);
  if (direct.length > 0) {
    const result = renumberPagesInDir(targetPath);
    return [{ path: targetPath, ...result }];
  }

  // Otherwise, try one level of chapter subdirectories.
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const chapterPath = path.join(targetPath, entry.name);
    const pages = listPageFiles(chapterPath);
    if (pages.length === 0) continue;
    const result = renumberPagesInDir(chapterPath);
    results.push({ path: chapterPath, ...result });
  }
  return results;
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
      if (result && typeof result.status === "number" && result.status >= 200 && result.status < 300) {
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
  const handle = (channel, handler) => {
    ipcMain.handle(channel, async (event, payload) => {
      const result = await handler(event, payload);
      if (result && typeof result === "object" && result.ok === false && result.error) {
        writeErrorLog({
          error: new Error(result.error.message || "IPC handler failed"),
          context: {
            source: "ipc",
            channel,
            code: result.error.code,
            details: result.error.details ?? null,
            payload: redactSecrets(payload ?? null),
          },
        }).catch(() => {});
      }
      return result;
    });
  };

  handle("list-downloads-library", async (_event, payload) => {
    const root = payload && typeof payload === "object" && typeof payload.root === "string" ? payload.root : "./downloads";
    const workspace = getUserWorkspaceDir();
    const resolvedRoot = path.resolve(workspace, root);

    const toRelPath = (absPath) => {
      const rel = path.relative(workspace, absPath);
      const normalized = rel.split(path.sep).join(path.posix.sep);
      return normalized.startsWith(".") ? normalized : `./${normalized}`;
    };

    try {
      if (!fs.existsSync(resolvedRoot)) {
        return createSuccess({ root: toRelPath(resolvedRoot), mangas: [] });
      }

      const mangaEntries = fs
        .readdirSync(resolvedRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const mangaName = entry.name;
          const mangaAbs = path.join(resolvedRoot, mangaName);
          const chapters = fs
            .readdirSync(mangaAbs, { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) => {
              const chapterAbs = path.join(mangaAbs, child.name);
              return {
                name: child.name,
                path: toRelPath(chapterAbs),
              };
            })
            .sort((a, b) => a.name.localeCompare(b.name));

          return {
            name: mangaName,
            path: toRelPath(mangaAbs),
            chapters,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      return createSuccess({ root: toRelPath(resolvedRoot), mangas: mangaEntries });
    } catch (error) {
      return createError(ErrorCodes.STAGE_EXECUTION_FAILED, "Failed to scan downloads library.", {
        root: resolvedRoot,
        reason: error?.message || String(error),
      });
    }
  });

  handle("get-app-settings", async () => {
    const settings = readAppSettings();
    const anthropicApiKey = typeof settings.anthropicApiKey === "string" ? settings.anthropicApiKey.trim() : "";
    const geminiApiKey = typeof settings.geminiApiKey === "string" ? settings.geminiApiKey.trim() : "";
    return createSuccess({
      hasAnthropicApiKey: Boolean(anthropicApiKey),
      hasGeminiApiKey: Boolean(geminiApiKey),
    });
  });

  handle("set-app-settings", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return createError(ErrorCodes.INVALID_REQUEST, "payload must be an object.");
    }

    const next = readAppSettings();
    if (Object.prototype.hasOwnProperty.call(payload, "anthropicApiKey")) {
      const value = payload.anthropicApiKey;
      if (value === null || value === undefined || value === "") {
        delete next.anthropicApiKey;
      } else if (typeof value === "string") {
        next.anthropicApiKey = value.trim();
      } else {
        return createError(ErrorCodes.INVALID_REQUEST, "anthropicApiKey must be a string or empty.");
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, "geminiApiKey")) {
      const value = payload.geminiApiKey;
      if (value === null || value === undefined || value === "") {
        delete next.geminiApiKey;
      } else if (typeof value === "string") {
        next.geminiApiKey = value.trim();
      } else {
        return createError(ErrorCodes.INVALID_REQUEST, "geminiApiKey must be a string or empty.");
      }
    }

    try {
      writeAppSettings(next);
      return createSuccess({
        hasAnthropicApiKey: typeof next.anthropicApiKey === "string" && next.anthropicApiKey.trim().length > 0,
        hasGeminiApiKey: typeof next.geminiApiKey === "string" && next.geminiApiKey.trim().length > 0,
      });
    } catch (error) {
      return createError(ErrorCodes.STAGE_EXECUTION_FAILED, "Failed to persist settings.", {
        reason: error?.message || String(error),
      });
    }
  });

  handle("open-path", async (_event, payload) => {
    if (!payload || typeof payload !== "object" || typeof payload.path !== "string") {
      return createError(ErrorCodes.INVALID_REQUEST, "path is required for open-path.");
    }

    const resolvedPath = path.resolve(getUserWorkspaceDir(), payload.path);
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

  handle("path-exists", async (_event, payload) => {
    if (!payload || typeof payload !== "object" || typeof payload.path !== "string") {
      return createError(ErrorCodes.INVALID_REQUEST, "path is required for path-exists.");
    }
    const resolvedPath = path.resolve(getUserWorkspaceDir(), payload.path);
    try {
      return createSuccess({ path: resolvedPath, exists: fs.existsSync(resolvedPath) });
    } catch (error) {
      return toUnknownError(error);
    }
  });

  handle("renumber-pages", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return createError(ErrorCodes.INVALID_REQUEST, "payload must be an object.");
    }

    const inputPath = typeof payload.path === "string" ? payload.path : null;
    const inputPaths = Array.isArray(payload.paths) ? payload.paths : null;

    const targets = [];
    if (inputPath) targets.push(inputPath);
    if (inputPaths) targets.push(...inputPaths.filter((value) => typeof value === "string"));

    if (targets.length === 0) {
      return createError(ErrorCodes.INVALID_REQUEST, "Provide path or paths.");
    }

    try {
      const normalizedTargets = targets.map((value) => path.resolve(getUserWorkspaceDir(), value));
      const allResults = [];
      let totalRenamed = 0;
      for (const target of normalizedTargets) {
        if (!fs.existsSync(target)) {
          return createError(ErrorCodes.INVALID_REQUEST, "Path does not exist.", { path: target });
        }
        const results = renumberPagesAtPath(target);
        for (const result of results) {
          totalRenamed += result.renamedCount;
          allResults.push({
            path: result.path,
            renamed_count: result.renamedCount,
            page_count: result.pageCount,
          });
        }
      }
      return createSuccess({ targets: allResults, total_renamed: totalRenamed });
    } catch (error) {
      return toUnknownError(error);
    }
  });

  handle("scrape-manga", async (_event, payload) => {
    if (!payload || typeof payload !== "object" || typeof payload.url !== "string") {
      return createError(ErrorCodes.INVALID_REQUEST, "url is required for scrape-manga.");
    }

    const outDir = payload.outDir || "./downloads";
    const python = pickPythonCommand();
    const args = [
      ...python.prefixArgs,
      "-m",
      "scripts.downloader.scraper",
      "--url",
      payload.url,
      "--out",
      outDir,
      "--details-only",
    ];

    try {
      const result = await runPythonCommand(python.command, args);
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

  handle("stage4-import-final-script", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return createError(ErrorCodes.INVALID_REQUEST, "payload must be an object.");
    }
    const recapPath = payload.recapPath;
    const finalScriptJson = payload.finalScriptJson;
    if (typeof recapPath !== "string" || !recapPath.trim()) {
      return createError(ErrorCodes.INVALID_REQUEST, "recapPath is required.");
    }
    if (typeof finalScriptJson !== "string" || !finalScriptJson.trim()) {
      return createError(ErrorCodes.INVALID_REQUEST, "refinedRecapJson is required.");
    }

    const resolvedRecap = path.resolve(process.cwd(), recapPath);
    const outPath = path.join(path.dirname(resolvedRecap), "recap_pages_with_sentences.json");

    let parsed;
    try {
      parsed = JSON.parse(finalScriptJson);
    } catch (error) {
      return createError(ErrorCodes.INVALID_REQUEST, "refinedRecapJson must be valid JSON.", {
        reason: error?.message || String(error),
      });
    }

    if (!parsed || typeof parsed !== "object") {
      return createError(ErrorCodes.INVALID_REQUEST, "refinedRecapJson must be a JSON object.");
    }
    if (parsed.mode !== "page") {
      return createError(ErrorCodes.INVALID_REQUEST, "Expected mode='page'.");
    }
    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      return createError(ErrorCodes.INVALID_REQUEST, "Expected non-empty pages[].");
    }
    for (const page of parsed.pages) {
      if (!page || typeof page !== "object" || !Number.isInteger(page.page_idx)) {
        return createError(ErrorCodes.INVALID_REQUEST, "Each pages[] item must include page_idx (int).");
      }
      if (typeof page.recap !== "string") {
        return createError(ErrorCodes.INVALID_REQUEST, "Each pages[] item must include recap (string).");
      }
      if (!Array.isArray(page.panels)) {
        return createError(ErrorCodes.INVALID_REQUEST, "Each pages[] item must include panels[].");
      }
      for (const panel of page.panels) {
        if (!panel || typeof panel !== "object") {
          return createError(ErrorCodes.INVALID_REQUEST, "Each panels[] item must be an object.");
        }
        if (!Number.isInteger(panel.sub_panel_idx)) {
          return createError(ErrorCodes.INVALID_REQUEST, "Each panels[] item must include sub_panel_idx (int).");
        }
        if (typeof panel.panel_id !== "string" || !panel.panel_id.trim()) {
          return createError(ErrorCodes.INVALID_REQUEST, "Each panels[] item must include panel_id (string).");
        }
        if (typeof panel.crop_path !== "string" || !panel.crop_path.trim()) {
          return createError(ErrorCodes.INVALID_REQUEST, "Each panels[] item must include crop_path (string).");
        }
        if (typeof panel.sentence !== "string") {
          return createError(ErrorCodes.INVALID_REQUEST, "Each panels[] item must include sentence (string).");
        }
      }
    }

    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
      sendStageEvent(_event, {
        type: "complete",
        stage: 4,
        refined_recap_path: outPath,
        imported: true,
      });
      return createSuccess({ refined_recap_path: outPath });
    } catch (error) {
      return createError(ErrorCodes.STAGE_EXECUTION_FAILED, "Failed to write recap_pages_with_sentences.json.", {
        reason: error?.message || String(error),
        outPath,
      });
    }
  });

  handle("stage4-import-gemini-json", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return createError(ErrorCodes.INVALID_REQUEST, "payload must be an object.");
    }
    const outPath = payload.outPath;
    const geminiJson = payload.geminiJson;
    if (typeof outPath !== "string" || !outPath.trim()) {
      return createError(ErrorCodes.INVALID_REQUEST, "outPath is required.");
    }
    if (typeof geminiJson !== "string" || !geminiJson.trim()) {
      return createError(ErrorCodes.INVALID_REQUEST, "geminiJson is required.");
    }

    let parsed;
    try {
      parsed = JSON.parse(geminiJson);
    } catch (error) {
      return createError(ErrorCodes.INVALID_REQUEST, "geminiJson must be valid JSON.", {
        reason: error?.message || String(error),
      });
    }

    if (!Array.isArray(parsed)) {
      return createError(ErrorCodes.INVALID_REQUEST, "geminiJson must be a JSON array of pages.", {
        receivedType: typeof parsed,
      });
    }

    const resolvedOut = path.resolve(process.cwd(), outPath);
    const geminiPath = path.join(path.dirname(resolvedOut), "gemini_narrator_pasted.json");

    try {
      fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
      fs.writeFileSync(geminiPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
      return createSuccess({ gemini_path: geminiPath });
    } catch (error) {
      return createError(ErrorCodes.STAGE_EXECUTION_FAILED, "Failed to write pasted Gemini JSON file.", {
        reason: error?.message || String(error),
        geminiPath,
      });
    }
  });

  handle("run-stage", async (_event, payload) => {
    const validationError = validateRunStagePayload(payload);
    if (validationError) {
      return validationError;
    }

    const { stage, args } = payload;
    console.log(`[run-stage] starting stage ${stage} with args: ${JSON.stringify(args)}`);

    try {
      if (stage === 0) {
        const python = pickPythonCommand();
        const runResult = await runPythonCommand(
          python.command,
          [...python.prefixArgs, "-m", "scripts.downloader.scraper", ...args],
          _event,
          stage,
        );
        return runResult;
      }

      if (stage === 1) {
        const python = pickPythonCommand();
        const runResult = await runPythonCommand(
          python.command,
          [...python.prefixArgs, "-m", "scripts.extract_chapter", ...args],
          _event,
          stage,
        );
        return runResult;
      }

      if (stage === 2) {
        const python = pickPythonCommand();
        const runResult = await runPythonCommand(
          python.command,
          [...python.prefixArgs, "-m", "scripts.gemini_accuracy_pass", ...args],
          _event,
          stage,
        );
        return runResult;
      }

      if (stage === 3) {
        const python = pickPythonCommand();
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
        const runResult = await runPythonCommand(
          python.command,
          [...python.prefixArgs, "-m", "scripts.make_panel_recaps", ...args],
          _event,
          stage,
        );
        return runResult;
      }

      if (stage === 4) {
        const python = pickPythonCommand();
        const runResult = await runPythonCommand(
          python.command,
          [...python.prefixArgs, "-m", "scripts.gemini_to_gento", ...args],
          _event,
          stage,
        );
        return runResult;
      }

      if (stage === 5) {
        const python = pickPythonCommand();
        const runResult = await runPythonCommand(
          python.command,
          [...python.prefixArgs, "-m", "scripts.generate_audio", ...args],
          _event,
          stage,
        );
        return runResult;
      }

      if (stage === 6) {
        const python = pickPythonCommand();
        const runResult = await runPythonCommand(
          python.command,
          [...python.prefixArgs, "-m", "scripts.render_video", ...args],
          _event,
          stage,
        );
        return runResult;
      }

      if (stage === 99) {
        const python = pickPythonCommand();
        const runResult = await runPythonCommand(
          python.command,
          [...python.prefixArgs, "-m", "scripts.prereqs", ...args],
          _event,
          stage,
        );
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

function runPythonCommand(command, commandArgs, ipcEvent, stageHint = null, extraEnv = null) {
  return new Promise((resolve) => {
    const proc = spawn(command, commandArgs, {
      cwd: getUserWorkspaceDir(),
      env: buildPythonEnv(extraEnv),
    });

    let stderr = "";
    const events = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const flushStdoutLines = (final = false) => {
      const parts = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = final ? "" : parts.pop() || "";
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
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
    };

    const flushStderrLines = (final = false) => {
      const parts = stderrBuffer.split(/\r?\n/);
      stderrBuffer = final ? "" : parts.pop() || "";
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
        console.error(`[run-stage] python stderr: ${line}`);
        if (ipcEvent) {
          sendStageEvent(ipcEvent, { type: "log", stage: stageHint, message: line });
        }
      }
    };

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      flushStdoutLines(false);
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrBuffer += text;
      flushStderrLines(false);
    });

    proc.on("close", (code) => {
      flushStdoutLines(true);
      flushStderrLines(true);
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

function buildPythonEnv(extraEnv) {
  const projectRoot = getProjectRoot();
  const userDataDir = app.getPath("userData");
  const env = extraEnv ? { ...process.env, ...extraEnv } : { ...process.env };

  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") || (process.platform === "win32" ? "Path" : "PATH");
  const currentPath = typeof env[pathKey] === "string" ? env[pathKey] : "";

  const pathParts = [];
  if (typeof ffmpegStatic === "string" && ffmpegStatic.trim()) {
    pathParts.push(path.dirname(ffmpegStatic));
    env.GENTO_FFMPEG_PATH = ffmpegStatic;
  }
  pathParts.push(currentPath);
  env[pathKey] = pathParts.filter(Boolean).join(path.delimiter);

  env.GENTO_PROJECT_ROOT = projectRoot;
  env.GENTO_USER_DATA_DIR = userDataDir;

  const settings = readAppSettings();
  if (settings && typeof settings === "object") {
    const anthropicApiKey = typeof settings.anthropicApiKey === "string" ? settings.anthropicApiKey.trim() : "";
    const geminiApiKey = typeof settings.geminiApiKey === "string" ? settings.geminiApiKey.trim() : "";
    if (anthropicApiKey && !env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = anthropicApiKey;
    }
    if (geminiApiKey && !env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) {
      env.GEMINI_API_KEY = geminiApiKey;
    }
  }

  const currentPythonPath = typeof env.PYTHONPATH === "string" ? env.PYTHONPATH : "";
  env.PYTHONPATH = [projectRoot, currentPythonPath].filter(Boolean).join(path.delimiter);

  return env;
}

module.exports = {
  registerStageIpcHandlers,
};
