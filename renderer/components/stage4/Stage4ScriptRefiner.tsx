import { type DragEventHandler, useEffect, useMemo, useState } from "react";
import { FiFolder, FiUploadCloud } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import { buildStage4Args, extractCompleteSummary, extractLastPercent, validateRefinedRecapPagesJson, type Stage4Provider } from "@/lib/stage4";

export type Stage4Session = {
  mangaUrl: string;
  totalChapters: number;
  selectedChapters: number;
  progress: number;
  isScraping: boolean;
  isRunningStage: boolean;
  lastOutputDir: string;
  stageMessage: string;
};

type Props = {
  onSessionUpdate?: (session: Stage4Session) => void;
};

type UiProvider = Stage4Provider | "manual";

export function Stage4ScriptRefiner({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [recapPagesPath, setRecapPagesPath] = useState("./output/final/recap_pages.json");
  const [provider, setProvider] = useState<UiProvider>("anthropic");
  const [model, setModel] = useState("claude-sonnet-4-20250514");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [manualImportJsonText, setManualImportJsonText] = useState<string>("");
  const [manualImportFilename, setManualImportFilename] = useState<string>("");

  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to refine recap_pages.json into recap_pages_with_sentences.json (Stage 4).");
  const [lastOutputDir, setLastOutputDir] = useState("./output/final");

  useEffect(() => {
    const raw = recapPagesPath.trim();
    if (!raw) return;
    const normalized = raw.replaceAll("\\", "/");
    const folderGuess = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : normalized;
    setLastOutputDir(folderGuess || "./output/final");
  }, [recapPagesPath]);

  useEffect(() => {
    if (provider === "anthropic") {
      setModel((prev) => (prev?.trim() ? prev : "claude-sonnet-4-20250514"));
    } else if (provider === "gemini") {
      setModel((prev) => (prev?.trim() ? prev : "gemini-1.5-pro"));
    }
  }, [provider]);

  useEffect(() => {
    if (provider !== "manual") {
      setManualImportJsonText("");
      setManualImportFilename("");
    }
  }, [provider]);

  const sessionState = useMemo<Stage4Session>(
    () => ({
      mangaUrl: recapPagesPath,
      totalChapters: 0,
      selectedChapters: 0,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [isRunningStage, lastOutputDir, progress, recapPagesPath, stageMessage],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  useEffect(() => {
    if (!window.gento?.onStageEvent) {
      return;
    }

    const unsubscribe = window.gento.onStageEvent((payload) => {
      if (!payload || payload.stage !== 4) {
        return;
      }

      if (payload.type === "progress") {
        setHasStageStarted(true);
        if (typeof payload.percent === "number") {
          setProgress(payload.percent);
        }
        if (payload.message) {
          setStageMessage(payload.message);
        }
        return;
      }

      if (payload.type === "log") {
        if (payload.message) {
          setStageMessage(payload.message);
        }
        return;
      }

      if (payload.type === "complete") {
        const outPath = payload.refined_recap_path ? payload.refined_recap_path : "";
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 4 complete.");
        if (payload.imported) {
          toast.success("Stage 4 imported", outPath ? `Saved ${outPath}` : "Imported recap_pages_with_sentences.json.");
        } else {
          toast.success("Stage 4 complete", outPath ? `Wrote ${outPath}` : "Refinement finished.");
        }
        setIsRunningStage(false);
        setHasStageStarted(false);
        return;
      }

      if (payload.type === "error") {
        const errorMessage =
          payload.error && typeof payload.error === "object"
            ? (payload.error as { message?: string }).message
            : undefined;
        setStageMessage(errorMessage || payload.message || "Stage 4 failed.");
        toast.error("Stage 4 failed", errorMessage || payload.message || "Stage 4 failed.");
        setProgress(0);
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
    });

    return unsubscribe;
  }, []);

  const handleRunStage4 = async () => {
    if (!recapPagesPath.trim()) {
      setStageMessage("Please provide the recap_pages.json path.");
      return;
    }
    if (provider === "manual") {
      if (!manualImportJsonText.trim()) {
        setStageMessage("Manual mode: choose/drop recap_pages_with_sentences.json first, then click Run Stage 4 to save it.");
        toast.error("Import failed", "Choose/drop a .json file first.");
        return;
      }
      if (isRunningStage || hasStageStarted) {
        return;
      }
      setIsRunningStage(true);
      setHasStageStarted(true);
      setProgress(5);
      setStageMessage("Importing recap_pages_with_sentences.json...");
      try {
        await importFinalScriptText(manualImportJsonText);
      } finally {
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
      return;
    }
    if (!window.gento || typeof window.gento.runStage !== "function") {
      setStageMessage("Desktop bridge is unavailable. Restart Electron to reload preload.");
      return;
    }
    if (isRunningStage || hasStageStarted) {
      return;
    }

    setIsRunningStage(true);
    setHasStageStarted(true);
    setProgress(5);
    setStageMessage("Starting Stage 4 refinement...");

    const args = buildStage4Args({
      recapPagesPath: recapPagesPath.trim(),
      provider,
      model: model.trim(),
      systemPrompt,
    });

    try {
      const result = await window.gento.runStage(4, args);
      if (!result.ok) {
        const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
        setStageMessage(message);
        toast.error("Stage 4 failed", message);
        setProgress(0);
        return;
      }

      const events = result.data?.events || [];
      const lastPercent = extractLastPercent(events);
      if (lastPercent !== null) {
        setProgress(lastPercent);
      }

      const complete = extractCompleteSummary(events);
      if (complete?.refinedRecapPath) {
        setProgress(100);
        setStageMessage(`Stage 4 complete: ${complete.refinedRecapPath}`);
        toast.success("Stage 4 complete", `Wrote ${complete.refinedRecapPath}`);
        return;
      }

      setProgress(100);
      setStageMessage("Stage 4 finished.");
      toast.success("Stage 4 complete", "Refinement finished.");
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Stage 4 failed: ${message}`);
      toast.error("Stage 4 failed", message);
      setProgress(0);
    } finally {
      setIsRunningStage(false);
      setHasStageStarted(false);
    }
  };

  const handleOpenFolder = async () => {
    if (!window.gento?.openPath) {
      setStageMessage("Desktop bridge is unavailable. Restart Electron to reload preload.");
      return;
    }
    const result = await window.gento.openPath(lastOutputDir);
    if (!result.ok) {
      const message = `Failed to open folder: ${result.error.message}`;
      setStageMessage(message);
      toast.error("Open folder failed", result.error.message);
    }
  };

  const importFinalScriptText = async (jsonText: string) => {
    if (!window.gento?.importStage4FinalScript) {
      setStageMessage("Desktop bridge is unavailable. Restart Electron to reload preload.");
      return;
    }
    if (!recapPagesPath.trim()) {
      const message = "Please provide the recap_pages.json path (used to choose where to save the imported file).";
      setStageMessage(message);
      toast.error("Import failed", message);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      const message = `Invalid JSON: ${(error as Error).message}`;
      setStageMessage(message);
      toast.error("Import failed", message);
      return;
    }
    const validation = validateRefinedRecapPagesJson(parsed);
    if (!validation.ok) {
      setStageMessage(validation.error);
      toast.error("Import failed", validation.error);
      return;
    }

    setProgress(10);
    setStageMessage("Importing recap_pages_with_sentences.json...");
    try {
      const result = await window.gento.importStage4FinalScript(recapPagesPath.trim(), jsonText);
      if (!result.ok) {
        const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
        setStageMessage(message);
        toast.error("Import failed", message);
        setProgress(0);
        return;
      }
      setProgress(100);
      setStageMessage(`Stage 4 imported: ${result.data.refined_recap_path}`);
      if (typeof result.data.refined_recap_path === "string" && result.data.refined_recap_path.trim()) {
        const normalized = result.data.refined_recap_path.replaceAll("\\", "/");
        const folderGuess = normalized.includes("/")
          ? normalized.slice(0, normalized.lastIndexOf("/"))
          : normalized;
        setLastOutputDir((prev) => folderGuess || prev);
      }
      toast.success("Stage 4 imported", `Saved ${result.data.refined_recap_path}`);
    } catch (error) {
      const message = (error as Error).message || String(error);
      setStageMessage(`Import failed: ${message}`);
      toast.error("Import failed", message);
      setProgress(0);
    }
  };

  const handleManualFile = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    setManualImportFilename(file.name || "");
    setManualImportJsonText(text);
    setProgress(0);
    setStageMessage(`Manual mode: ready to save ${file.name || "selected file"}. Click Run Stage 4.`);
  };

  const handleDrop: DragEventHandler<HTMLDivElement> = async (event) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    const jsonFile = files.find((f) => f.type === "application/json" || f.name.toLowerCase().endsWith(".json"));
    if (!jsonFile) {
      toast.error("Import failed", "Drop a .json file.");
      return;
    }
    await handleManualFile(jsonFile);
  };

  return (
    <Card className="lg:flex lg:flex-col lg:min-h-0 lg:h-full">
      <CardHeader className="border-b border-border/60 p-5">
        <CardTitle>Stage 4 Refine</CardTitle>
        <CardDescription>
          Refine the Stage 3 recap into `recap_pages_with_sentences.json` using Claude or Gemini, or import your own JSON output.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            recap_pages.json path
          </label>
          <input
            type="text"
            value={recapPagesPath}
            onChange={(event) => setRecapPagesPath(event.target.value)}
            placeholder="./output/final/recap_pages.json"
            className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Provider
            </label>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as UiProvider)}
              className="glass-interactive h-10 w-full appearance-none rounded-xl border px-3 pr-9 text-sm text-foreground outline-none"
            >
              <option value="anthropic">Claude (Anthropic)</option>
              <option value="gemini">Gemini (Google)</option>
              <option value="manual">Manual import (JSON)</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Model
            </label>
            <input
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={provider === "manual"}
              placeholder={provider === "gemini" ? "gemini-1.5-pro" : "claude-sonnet-4-20250514"}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none disabled:opacity-60"
            />
          </div>
        </div>

        {provider !== "manual" ? (
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              System prompt (optional)
            </label>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="Leave blank to use the default Stage 4 refinement prompt."
              className="glass-interactive min-h-[120px] w-full rounded-xl border px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              className="glass-surface flex items-center justify-between gap-3 rounded-2xl border border-dashed border-border/70 p-4"
            >
              <div className="flex items-center gap-3">
                <FiUploadCloud className="h-5 w-5 text-muted-foreground" />
                <div className="text-sm">
                  <p className="font-medium text-foreground">Drop `recap_pages_with_sentences.json` here</p>
                  <p className="text-xs text-muted-foreground">
                    {manualImportFilename ? `Selected: ${manualImportFilename}. Click Run Stage 4 to save.` : "Must match the required JSON schema (no plain text)."}
                  </p>
                </div>
              </div>
              <label className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm text-foreground hover:bg-muted/40 cursor-pointer">
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(event) => handleManualFile(event.target.files?.[0] ?? null)}
                />
                Choose file
              </label>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleRunStage4} disabled={isRunningStage} className="rounded-xl">
            Run Stage 4
          </Button>
          <Button variant="secondary" onClick={handleOpenFolder} className="gap-2 rounded-xl">
            <FiFolder className="h-4 w-4" />
            Open folder
          </Button>
          <div className="text-xs text-muted-foreground">
            {provider === "anthropic" ? "Requires ANTHROPIC_API_KEY" : provider === "gemini" ? "Requires GEMINI_API_KEY or GOOGLE_API_KEY" : "Manual JSON import"}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{stageMessage}</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      </CardContent>
    </Card>
  );
}
