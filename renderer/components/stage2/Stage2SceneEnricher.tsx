import { useEffect, useMemo, useState } from "react";
import { FiFolder } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import { buildStage2Args, extractCompleteSummary, extractLastPercent } from "@/lib/stage2";

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

export function Stage2SceneEnricher({ onSessionUpdate }: Props) {
  const toast = useToast();
  const [storyboardPath, setStoryboardPath] = useState("./output/final/storyboard.json");
  const [sceneProvider, setSceneProvider] = useState<"ollama" | "none">("ollama");
  const [ollamaHost, setOllamaHost] = useState("http://127.0.0.1:11434");
  const [ollamaModel, setOllamaModel] = useState("gemma3:4b");
  const [overwrite, setOverwrite] = useState(false);
  const [chapterContext, setChapterContext] = useState("");

  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to enrich storyboard panels with scene captions.");
  const [lastOutputDir, setLastOutputDir] = useState("./output");

  useEffect(() => {
    const raw = storyboardPath.trim();
    if (!raw) {
      return;
    }
    const normalized = raw.replaceAll("\\", "/");
    const folderGuess = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : normalized;
    setLastOutputDir(folderGuess || "./output");
  }, [storyboardPath]);

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
        const summary = payload.storyboard_path ? payload.storyboard_path : "";
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 2 complete.");
        if (summary) {
          toast.success("Stage 2 complete", `Updated ${summary}`);
        } else {
          toast.success("Stage 2 complete", "Scene enrichment finished.");
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
    setStageMessage("Starting Stage 2 scene enrichment...");

    const args = buildStage2Args({
      storyboardPath: storyboardPath.trim(),
      sceneProvider,
      ollamaHost: ollamaHost.trim(),
      ollamaModel: ollamaModel.trim(),
      overwrite,
      chapterContext,
    });

    try {
      const result = await window.gento.runStage(2, args);
      if (!result.ok) {
        const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
        setStageMessage(message);
        toast.error("Stage 2 failed", message);
        setProgress(0);
        return;
      }

      const events = result.data?.events || [];
      const lastPercent = extractLastPercent(events);
      if (lastPercent !== null) {
        setProgress(lastPercent);
      }

      const complete = extractCompleteSummary(events);
      if (complete?.storyboardPath) {
        setProgress(100);
        setStageMessage(`Stage 2 complete: ${complete.storyboardPath}`);
        toast.success("Stage 2 complete", `Updated ${complete.storyboardPath}`);
        return;
      }

      setProgress(100);
      setStageMessage("Stage 2 finished.");
      toast.success("Stage 2 complete", "Scene enrichment finished.");
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
        <CardTitle>Stage 2 Scenes</CardTitle>
        <CardDescription>
          Generate a caption + semantic tags for each panel in storyboard.json using a local vision model.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            storyboard.json path
          </label>
          <input
            type="text"
            value={storyboardPath}
            onChange={(event) => setStoryboardPath(event.target.value)}
            placeholder="./output/final/storyboard.json"
            className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Provider
            </label>
            <div className="relative">
              <select
                value={sceneProvider}
                onChange={(event) => setSceneProvider(event.target.value as "ollama" | "none")}
                className="glass-interactive h-10 w-full appearance-none rounded-xl border px-3 pr-9 text-sm text-foreground outline-none"
              >
                <option value="ollama">Ollama</option>
                <option value="none">None</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Overwrite
            </label>
            <label className="glass-surface flex h-10 items-center justify-between rounded-xl border px-3 text-sm text-foreground">
              <span>Replace existing captions</span>
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
                className="h-4 w-4"
              />
            </label>
          </div>
        </div>

        {sceneProvider === "ollama" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Ollama host
              </label>
              <input
                type="text"
                value={ollamaHost}
                onChange={(event) => setOllamaHost(event.target.value)}
                placeholder="http://127.0.0.1:11434"
                className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Ollama model
              </label>
              <input
                type="text"
                value={ollamaModel}
                onChange={(event) => setOllamaModel(event.target.value)}
                placeholder="llava-phi3:latest"
                className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
              />
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Chapter context (optional)
          </label>
          <textarea
            value={chapterContext}
            onChange={(event) => setChapterContext(event.target.value)}
            placeholder="Shounen action manga. Protagonist has spiky black hair."
            rows={3}
            className="glass-interactive w-full rounded-xl border px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="space-y-3 rounded-3xl border border-border/60 bg-background/60 p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-foreground">Progress</div>
            <div className="text-xs text-muted-foreground">{progress}%</div>
          </div>
          <Progress value={progress} />
          <p className="text-sm text-muted-foreground">{stageMessage}</p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button onClick={handleRunStage2} disabled={isRunningStage || hasStageStarted} className="gap-2">
            Run Stage 2
          </Button>
          <Button variant="secondary" onClick={handleOpenFolder} className="gap-2">
            <FiFolder />
            Open folder
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
