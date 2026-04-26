import { useEffect, useMemo, useState } from "react";
import { FiFolder } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import {
  buildStage5Args,
  extractCompleteSummary,
  extractLastPercent,
} from "@/lib/stage5";

export type Stage5Session = {
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
  onSessionUpdate?: (session: Stage5Session) => void;
};

export function Stage5AudioGenerator({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [refinedRecapPagesPath, setRefinedRecapPagesPath] = useState(
    "./output/final/recap_pages_with_sentences.json",
  );
  const [voice, setVoice] = useState("am_echo");
  const [speed, setSpeed] = useState(1.2);
  const [timingTts, setTimingTts] = useState(false);

  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState(
    "Ready to generate audio (Stage 5).",
  );
  const [lastOutputDir, setLastOutputDir] = useState("./output/final/audio");

  useEffect(() => {
    const raw = refinedRecapPagesPath.trim();
    if (!raw) {
      return;
    }
    const normalized = raw.replaceAll("\\", "/");
    const folderGuess = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : normalized;
    setLastOutputDir((folderGuess || "./output/final") + "/audio");
  }, [refinedRecapPagesPath]);

  const sessionState = useMemo<Stage5Session>(
    () => ({
      mangaUrl: refinedRecapPagesPath,
      totalChapters: 0,
      selectedChapters: 0,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [
      isRunningStage,
      lastOutputDir,
      progress,
      refinedRecapPagesPath,
      stageMessage,
    ],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  useEffect(() => {
    if (!window.gento?.onStageEvent) {
      return;
    }

    const unsubscribe = window.gento.onStageEvent((payload) => {
      if (!payload || payload.stage !== 5) {
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
        const outScript = payload.final_script_path
          ? payload.final_script_path
          : "";
        const outAudio = payload.stitched_audio_path
          ? payload.stitched_audio_path
          : "";
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 5 complete.");
        toast.success(
          "Stage 5 complete",
          outScript
            ? `Wrote ${outScript}`
            : outAudio
              ? `Wrote ${outAudio}`
              : "Audio outputs written.",
        );
        setIsRunningStage(false);
        setHasStageStarted(false);
        return;
      }

      if (payload.type === "error") {
        const errorMessage =
          payload.error && typeof payload.error === "object"
            ? (payload.error as { message?: string }).message
            : undefined;
        setStageMessage(errorMessage || payload.message || "Stage 5 failed.");
        toast.error(
          "Stage 5 failed",
          errorMessage || payload.message || "Stage 5 failed.",
        );
        setProgress(0);
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
    });

    return unsubscribe;
  }, []);

  const handleRunStage5 = async () => {
    if (!refinedRecapPagesPath.trim()) {
      setStageMessage(
        "Please provide the recap_pages_with_sentences.json path.",
      );
      return;
    }
    if (!window.gento || typeof window.gento.runStage !== "function") {
      setStageMessage(
        "Desktop bridge is unavailable. Restart Electron to reload preload.",
      );
      return;
    }
    if (isRunningStage || hasStageStarted) {
      return;
    }

    setIsRunningStage(true);
    setHasStageStarted(true);
    setProgress(5);
    setStageMessage("Starting Stage 5 audio generation...");

    const args = buildStage5Args({
      refinedRecapPagesPath: refinedRecapPagesPath.trim(),
      voice: voice.trim(),
      speed,
      timingTts,
    });

    try {
      const result = await window.gento.runStage(5, args);
      if (!result.ok) {
        const message = formatRuntimeError(
          result.error.code,
          result.error.message,
          result.error.details,
        );
        setStageMessage(message);
        toast.error("Stage 5 failed", message);
        setProgress(0);
        return;
      }

      const events = result.data?.events || [];
      const lastPercent = extractLastPercent(events);
      if (lastPercent !== null) {
        setProgress(lastPercent);
      }

      const complete = extractCompleteSummary(events);
      if (complete?.finalScriptPath) {
        setProgress(100);
        setStageMessage(`Stage 5 complete: ${complete.finalScriptPath}`);
        toast.success("Stage 5 complete", `Wrote ${complete.finalScriptPath}`);
        return;
      }

      setProgress(100);
      setStageMessage("Stage 5 finished.");
      toast.success("Stage 5 complete", "Audio generation finished.");
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Stage 5 failed: ${message}`);
      toast.error("Stage 5 failed", message);
      setProgress(0);
    } finally {
      setIsRunningStage(false);
      setHasStageStarted(false);
    }
  };

  const handleOpenFolder = async () => {
    if (!window.gento?.openPath) {
      setStageMessage(
        "Desktop bridge is unavailable. Restart Electron to reload preload.",
      );
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
        <CardTitle>Stage 5 Audio</CardTitle>
        <CardDescription>
          Generate narration audio and per-panel timestamps from Stage 4
          outputs.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            recap_pages_with_sentences.json path
          </label>
          <input
            type="text"
            value={refinedRecapPagesPath}
            onChange={(event) => setRefinedRecapPagesPath(event.target.value)}
            placeholder="./output/final/recap_pages_with_sentences.json"
            className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Voice
            </label>
            <input
              type="text"
              value={voice}
              onChange={(event) => setVoice(event.target.value)}
              placeholder="am_echo"
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Speed
            </label>
            <input
              type="number"
              value={speed}
              step={0.05}
              min={0.5}
              max={2.0}
              onChange={(event) => setSpeed(Number(event.target.value))}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={timingTts}
            onChange={(event) => setTimingTts(event.target.checked)}
            className="h-4 w-4"
          />
          Generate timing TTS per panel (slower, improves sync)
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={handleRunStage5}
            disabled={isRunningStage}
            className="rounded-xl"
          >
            Run Stage 5
          </Button>
          <Button
            variant="secondary"
            onClick={handleOpenFolder}
            className="gap-2 rounded-xl"
          >
            <FiFolder className="h-4 w-4" />
            Open folder
          </Button>
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
