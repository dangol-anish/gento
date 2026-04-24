import { useEffect, useMemo, useState } from "react";
import { FiFolder } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import { buildStage6Args, extractCompleteSummary, extractLastPercent } from "@/lib/stage6";

export type Stage6Session = {
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
  onSessionUpdate?: (session: Stage6Session) => void;
};

export function Stage6VideoRenderer({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [finalScriptPath, setFinalScriptPath] = useState("./output/final/final_script.json");
  const [outMp4, setOutMp4] = useState("./output/final/video.mp4");
  const [fps, setFps] = useState(24);
  const [crf, setCrf] = useState(18);
  const [preset, setPreset] = useState("veryfast");

  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to render video (Stage 6).");
  const [lastOutputDir, setLastOutputDir] = useState("./output/final");

  useEffect(() => {
    const raw = outMp4.trim();
    if (!raw) return;
    const normalized = raw.replaceAll("\\", "/");
    const folder = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : normalized;
    setLastOutputDir(folder || "./output/final");
  }, [outMp4]);

  const sessionState = useMemo<Stage6Session>(
    () => ({
      mangaUrl: finalScriptPath,
      totalChapters: 0,
      selectedChapters: 0,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [finalScriptPath, isRunningStage, lastOutputDir, progress, stageMessage],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  useEffect(() => {
    if (!window.gento?.onStageEvent) return;
    const unsubscribe = window.gento.onStageEvent((payload) => {
      if (!payload || payload.stage !== 6) return;

      if (payload.type === "progress") {
        setHasStageStarted(true);
        if (typeof payload.percent === "number") setProgress(payload.percent);
        if (payload.message) setStageMessage(payload.message);
        return;
      }

      if (payload.type === "log") {
        if (payload.message) setStageMessage(payload.message);
        return;
      }

      if (payload.type === "complete") {
        const videoPath = (payload as any).video_path as string | undefined;
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 6 complete.");
        toast.success("Stage 6 complete", videoPath ? `Wrote ${videoPath}` : "Video output written.");
        setIsRunningStage(false);
        setHasStageStarted(false);
        return;
      }

      if (payload.type === "error") {
        const errorMessage =
          payload.error && typeof payload.error === "object"
            ? (payload.error as { message?: string }).message
            : undefined;
        setStageMessage(errorMessage || payload.message || "Stage 6 failed.");
        toast.error("Stage 6 failed", errorMessage || payload.message || "Stage 6 failed.");
        setProgress(0);
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
    });
    return unsubscribe;
  }, []);

  const handleRunStage6 = async () => {
    if (!finalScriptPath.trim()) {
      setStageMessage("Please provide the final_script.json path.");
      return;
    }
    if (!window.gento || typeof window.gento.runStage !== "function") {
      setStageMessage("Desktop bridge is unavailable. Restart Electron to reload preload.");
      return;
    }
    if (isRunningStage || hasStageStarted) return;

    setIsRunningStage(true);
    setHasStageStarted(true);
    setProgress(5);
    setStageMessage("Starting Stage 6 video render...");

    const args = buildStage6Args({
      finalScriptPath: finalScriptPath.trim(),
      outMp4: outMp4.trim(),
      fps,
      crf,
      preset: preset.trim(),
      overwrite: true,
    });

    try {
      const result = await window.gento.runStage(6, args);
      if (!result.ok) {
        const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
        setStageMessage(message);
        toast.error("Stage 6 failed", message);
        setProgress(0);
        return;
      }

      const events = result.data?.events || [];
      const lastPercent = extractLastPercent(events);
      if (lastPercent !== null) setProgress(lastPercent);

      const complete = extractCompleteSummary(events);
      if (complete?.videoPath) {
        setProgress(100);
        setStageMessage(`Stage 6 complete: ${complete.videoPath}`);
        toast.success("Stage 6 complete", `Wrote ${complete.videoPath}`);
        return;
      }

      setProgress(100);
      setStageMessage("Stage 6 finished.");
      toast.success("Stage 6 complete", "Video render finished.");
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Stage 6 failed: ${message}`);
      toast.error("Stage 6 failed", message);
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
        <CardTitle>Stage 6 Video</CardTitle>
        <CardDescription>Render an MP4 from panel crops and Stage 5 stitched narration (ffmpeg).</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            final_script.json path
          </label>
          <input
            type="text"
            value={finalScriptPath}
            onChange={(event) => setFinalScriptPath(event.target.value)}
            placeholder="./output/final/final_script.json"
            className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Output mp4 path
          </label>
          <input
            type="text"
            value={outMp4}
            onChange={(event) => setOutMp4(event.target.value)}
            placeholder="./output/final/video.mp4"
            className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">FPS</label>
            <input
              type="number"
              value={fps}
              min={1}
              max={120}
              onChange={(event) => setFps(Number(event.target.value))}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">CRF</label>
            <input
              type="number"
              value={crf}
              min={0}
              max={40}
              onChange={(event) => setCrf(Number(event.target.value))}
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>

          <div className="space-y-2 lg:col-span-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resolution</label>
            <div className="glass-interactive flex h-10 items-center rounded-xl border px-3 text-sm text-foreground">
              1920 × 1080 (fixed)
            </div>
          </div>

          <div className="space-y-2 lg:col-span-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preset</label>
            <input
              type="text"
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
              placeholder="veryfast"
              className="glass-interactive h-10 w-full rounded-xl border px-3 text-sm text-foreground outline-none"
            />
          </div>
        </div>

        <div className="space-y-2 rounded-2xl border border-border/60 bg-background/70 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{stageMessage}</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button onClick={handleRunStage6} disabled={isRunningStage || hasStageStarted} className="rounded-xl">
            {isRunningStage ? "Rendering..." : "Run Stage 6"}
          </Button>
          <Button variant="secondary" onClick={handleOpenFolder} className="rounded-xl gap-2">
            <FiFolder className="h-4 w-4" />
            Open folder
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
