import { useEffect, useMemo, useState } from "react";
import { FiEye, FiEyeOff, FiFolder } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import { buildStage2GeminiArgs, extractStage2GeminiCompleteSummary, extractStage2GeminiLastPercent } from "@/lib/stage2Gemini";

export type Stage2Session = {
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
  onSessionUpdate?: (session: Stage2Session) => void;
};

export function Stage2GeminiAccuracyPass({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [storyboardPath, setStoryboardPath] = useState("./output/final/storyboard.json");
  const [outPath, setOutPath] = useState("./output/final/gemini_output");
  const [model, setModel] = useState("gemini-2.5-pro");
  const [timeoutSeconds, setTimeoutSeconds] = useState(120);
  const [startPage, setStartPage] = useState(1);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [hasGeminiApiKey, setHasGeminiApiKey] = useState(false);
  const [showGeminiApiKey, setShowGeminiApiKey] = useState(false);

  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to generate gemini_output from page images (Stage 2).");
  const [lastOutputDir, setLastOutputDir] = useState("./output/final");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!window.gento?.getAppSettings) return;
      const result = await window.gento.getAppSettings();
      if (!result.ok) return;
      if (cancelled) return;
      setHasGeminiApiKey(Boolean(result.data.hasGeminiApiKey));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const raw = outPath.trim();
    if (!raw) return;
    const normalized = raw.replaceAll("\\", "/");
    const folderGuess = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : normalized;
    setLastOutputDir(folderGuess || "./output/final");
  }, [outPath]);

  const sessionState = useMemo<Stage2Session>(
    () => ({
      mangaUrl: storyboardPath,
      totalChapters: 0,
      selectedChapters: 0,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [isRunningStage, lastOutputDir, progress, stageMessage, storyboardPath],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  useEffect(() => {
    if (!window.gento?.onStageEvent) {
      return;
    }

    const unsubscribe = window.gento.onStageEvent((payload) => {
      if (!payload || payload.stage !== 2) {
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
        const outputPath = payload.gemini_output_path ? payload.gemini_output_path : "";
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 2 complete.");
        toast.success("Stage 2 complete", outputPath ? `Wrote ${outputPath}` : "Gemini output written.");
        setIsRunningStage(false);
        setHasStageStarted(false);
        return;
      }

      if (payload.type === "error") {
        const errorMessage =
          payload.error && typeof payload.error === "object"
            ? (payload.error as { message?: string }).message
            : undefined;
        setStageMessage(errorMessage || payload.message || "Stage 2 failed.");
        toast.error("Stage 2 failed", errorMessage || payload.message || "Stage 2 failed.");
        setProgress(0);
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
    });

    return unsubscribe;
  }, []);

  const handleRunStage2 = async () => {
    if (!storyboardPath.trim()) {
      setStageMessage("Please provide the storyboard.json path.");
      return;
    }
    if (!outPath.trim()) {
      setStageMessage("Please provide the output path (gemini_output).");
      return;
    }
    if (!window.gento || typeof window.gento.runStage !== "function") {
      setStageMessage("Desktop bridge is unavailable. Restart Electron to reload preload.");
      return;
    }
    if (isRunningStage || hasStageStarted) {
      return;
    }
    if (!hasGeminiApiKey && !geminiApiKey.trim()) {
      setStageMessage("Please enter your Gemini API key (or save it in Settings) before running Stage 2.");
      return;
    }

    setIsRunningStage(true);
    setHasStageStarted(true);
    setProgress(5);
    setStageMessage("Starting Stage 2 Gemini Transcriber + Narrator...");

    try {
      if (geminiApiKey.trim() && window.gento?.setAppSettings) {
        const result = await window.gento.setAppSettings({ geminiApiKey: geminiApiKey.trim() });
        if (!result.ok) {
          const message = `Failed to save Gemini API key: ${result.error.message}`;
          setStageMessage(message);
          toast.error("Stage 2 failed", message);
          setProgress(0);
          return;
        }
        setHasGeminiApiKey(Boolean(result.data.hasGeminiApiKey));
        setGeminiApiKey("");
      }

      const args = buildStage2GeminiArgs({
        storyboardPath: storyboardPath.trim(),
        outPath: outPath.trim(),
        model,
        startPage,
        timeoutSeconds,
      });

      const result = await window.gento.runStage(2, args);
      if (!result.ok) {
        const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
        setStageMessage(message);
        toast.error("Stage 2 failed", message);
        setProgress(0);
        return;
      }

      const events = result.data?.events || [];
      const lastPercent = extractStage2GeminiLastPercent(events);
      if (lastPercent !== null) {
        setProgress(lastPercent);
      }

      const complete = extractStage2GeminiCompleteSummary(events);
      if (complete?.geminiOutputPath) {
        setProgress(100);
        setStageMessage(`Stage 2 complete: ${complete.geminiOutputPath}`);
        toast.success("Stage 2 complete", `Wrote ${complete.geminiOutputPath}`);
        return;
      }

      setProgress(100);
      setStageMessage("Stage 2 finished.");
      toast.success("Stage 2 complete", "Gemini output written.");
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Stage 2 failed: ${message}`);
      toast.error("Stage 2 failed", message);
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

  return (
      <Card className="lg:flex lg:flex-col lg:min-h-0 lg:h-full">
      <CardHeader className="border-b border-border/60 p-5">
        <CardTitle>Stage 2 Gemini Transcriber + Narrator</CardTitle>
        <CardDescription>
          Send the manga page images from `storyboard.json` to Gemini and write narrator-style JSON to `gemini_output`.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Gemini API key {hasGeminiApiKey ? "(saved)" : "(not set)"}
          </label>
          <div className="flex gap-2">
            <input
              type={showGeminiApiKey ? "text" : "password"}
              value={geminiApiKey}
              onChange={(event) => setGeminiApiKey(event.target.value)}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder={hasGeminiApiKey ? "Enter to replace…" : "AIza…"}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
            />
            <Button
              type="button"
              variant="secondary"
              className="h-10 w-10 shrink-0 rounded-xl p-0"
              onClick={() => setShowGeminiApiKey((v) => !v)}
              title={showGeminiApiKey ? "Hide API key" : "Show API key"}
              aria-label={showGeminiApiKey ? "Hide API key" : "Show API key"}
            >
              {showGeminiApiKey ? <FiEyeOff className="h-4 w-4" /> : <FiEye className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Saved locally and injected into Stage 2 as an environment variable.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            storyboard path
          </label>
          <input
            value={storyboardPath}
            onChange={(event) => setStoryboardPath(event.target.value)}
            className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            placeholder="./output/final/storyboard.json"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            gemini_output path
          </label>
          <input
            value={outPath}
            onChange={(event) => setOutPath(event.target.value)}
            className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            placeholder="./output/final/gemini_output"
          />
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              model
            </label>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
              placeholder="gemini-2.5-pro"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              start page
            </label>
            <input
              type="number"
              value={startPage}
              onChange={(event) => setStartPage(Math.max(1, Number(event.target.value || 1)))}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
              min={1}
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              timeout (s)
            </label>
            <input
              type="number"
              value={timeoutSeconds}
              onChange={(event) => setTimeoutSeconds(Number(event.target.value))}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
              min={10}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleRunStage2} disabled={isRunningStage}>
            {isRunningStage ? "Running…" : "Run Stage 2"}
          </Button>
          <Button variant="secondary" onClick={handleOpenFolder} className="gap-2">
            <FiFolder /> Open output folder
          </Button>
        </div>

        <div className="space-y-2 rounded-2xl border border-border/60 bg-background/60 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
          <p className="text-sm text-foreground">{stageMessage}</p>
        </div>
      </CardContent>
    </Card>
  );
}
