import { useEffect, useMemo, useState } from "react";
import { FiChevronDown, FiFolder } from "react-icons/fi";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import {
  buildStage1Args,
  extractCompleteSummary,
  extractLastPercent,
  STAGE1_MODEL,
} from "@/lib/stage1";
import { useToast } from "@/components/ui/toast";

export type Stage1Session = {
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
  outDir?: string;
  onSessionUpdate?: (session: Stage1Session) => void;
  recentChapterDirs?: string[];
};

export function Stage1Extractor({ outDir = "./output", onSessionUpdate, recentChapterDirs = [] }: Props) {
  const toast = useToast();
  const [imageFolder, setImageFolder] = useState("./downloads");
  const [chapterId, setChapterId] = useState("chapter_1");
  const [device, setDevice] = useState<"auto" | "cpu" | "mps" | "cuda">("auto");
  const [allowDownloads, setAllowDownloads] = useState(false);
  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to extract panels from downloaded pages.");
  const [lastOutputDir, setLastOutputDir] = useState(outDir);
  const [storyboardPath, setStoryboardPath] = useState("");

  const sessionState = useMemo<Stage1Session>(
    () => ({
      mangaUrl: imageFolder,
      totalChapters: 0,
      selectedChapters: 0,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [imageFolder, progress, isRunningStage, lastOutputDir, stageMessage],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  useEffect(() => {
    if (imageFolder.trim() !== "./downloads") {
      return;
    }
    if (recentChapterDirs.length === 1) {
      setImageFolder(recentChapterDirs[0]);
    }
  }, [imageFolder, recentChapterDirs]);

  useEffect(() => {
    if (!window.gento?.onStageEvent) {
      return;
    }

    const unsubscribe = window.gento.onStageEvent((payload) => {
      if (!payload || payload.stage !== 1) {
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
        setStoryboardPath(summary);
        setLastOutputDir(outDir);
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 1 extraction complete.");
        toast.success("Stage 1 complete", summary ? `Wrote ${summary}` : "Storyboard written.");
        setIsRunningStage(false);
        setHasStageStarted(false);
        return;
      }

      if (payload.type === "error") {
        const errorMessage =
          payload.error && typeof payload.error === "object"
            ? (payload.error as { message?: string }).message
            : undefined;

        setStageMessage(
          errorMessage || payload.message || "Stage 1 extraction failed.",
        );
        toast.error("Stage 1 failed", errorMessage || payload.message || "Stage 1 extraction failed.");
        setProgress(0);
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
    });

    return unsubscribe;
  }, [outDir]);

  const handleRunStage1 = async () => {
    if (!imageFolder.trim()) {
      setStageMessage("Please provide the downloaded images folder.");
      return;
    }
    if (imageFolder.trim() === "./downloads") {
      setStageMessage(
        "Please select a specific downloaded chapter folder (not the downloads root).",
      );
      toast.error(
        "Select a chapter folder",
        "Stage 1 expects a single chapter folder containing page_*.jpg files.",
      );
      return;
    }
    if (!chapterId.trim()) {
      setStageMessage("Please provide a chapter ID.");
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
    setProgress(10);
    setStageMessage("Starting Stage 1 extraction...");

    const args = buildStage1Args({
      chapterId: chapterId.trim(),
      imagesDir: imageFolder.trim(),
      outDir,
      device,
      allowDownloads,
    });

    try {
      const result = await window.gento.runStage(1, args);
      if (!result.ok) {
        const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
        setStageMessage(message);
        toast.error("Extraction failed", message);
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
        setStoryboardPath(complete.storyboardPath);
        setLastOutputDir(outDir);
        setProgress(100);
        setStageMessage(`Stage 1 complete: ${complete.storyboardPath}`);
        toast.success("Stage 1 complete", `Wrote ${complete.storyboardPath}`);
      } else {
        setProgress(100);
        setStageMessage("Stage 1 extraction finished.");
        toast.success("Stage 1 complete", "Stage 1 extraction finished.");
      }
    } catch (error) {
      const message = (error as Error).message;
      setStageMessage(`Extraction failed: ${message}`);
      toast.error("Extraction failed", message);
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
        <CardTitle>Stage 1 Extractor</CardTitle>
        <CardDescription>
          Run Magi panel extraction and write storyboard.json from downloaded images.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        {recentChapterDirs.length > 0 ? (
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent downloads
            </label>
            <div className="relative">
              <select
                value={recentChapterDirs.includes(imageFolder) ? imageFolder : ""}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next) setImageFolder(next);
                }}
                className="glass-interactive h-10 w-full appearance-none rounded-xl border px-3 pr-9 text-sm text-foreground outline-none"
              >
                <option value="" disabled>
                  Select a chapter folder…
                </option>
                {recentChapterDirs.map((dir) => (
                  <option key={dir} value={dir}>
                    {dir}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                <FiChevronDown />
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Stage 1 should run on a single chapter folder (pages only), not the downloads root.
            </p>
          </div>
        ) : null}

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Images folder
          </label>
          <input
            type="text"
            value={imageFolder}
            onChange={(event) => setImageFolder(event.target.value)}
            placeholder="./downloads/Your Manga/Chapter 1"
            className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Chapter ID
            </label>
            <input
              type="text"
              value={chapterId}
              onChange={(event) => setChapterId(event.target.value)}
              placeholder="chapter_1"
              className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Output root
            </label>
            <input
              type="text"
              value={outDir}
              readOnly
              className="glass-surface h-10 w-full rounded-xl px-3 text-sm text-muted-foreground outline-none border"
            />
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Device
            </label>
            <div className="relative">
              <select
                value={device}
                onChange={(event) => setDevice(event.target.value as "auto" | "cpu" | "mps" | "cuda")}
                className="glass-interactive h-10 w-full appearance-none rounded-xl border pl-3 pr-10 text-sm text-foreground outline-none"
              >
                <option value="auto">auto</option>
                <option value="cpu">cpu</option>
                <option value="mps">mps</option>
                <option value="cuda">cuda</option>
              </select>
              <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Model
            </label>
            <input
              type="text"
              value={STAGE1_MODEL}
              readOnly
              className="glass-surface h-10 w-full rounded-xl px-3 text-sm text-muted-foreground outline-none border"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={allowDownloads}
            onChange={(event) => setAllowDownloads(event.target.checked)}
            className="h-4 w-4 accent-black"
          />
          Allow Hugging Face downloads if missing locally
        </label>

        <Progress value={progress} />
        <p className="text-sm text-muted-foreground/90">{stageMessage}</p>

        {storyboardPath ? (
          <div className="rounded-2xl border border-border/50 bg-background/80 p-3 text-sm text-muted-foreground">
            <p>Storyboard:</p>
            <p className="truncate text-foreground">{storyboardPath}</p>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-3">
            <Button onClick={handleRunStage1} disabled={isRunningStage || hasStageStarted}>
              {isRunningStage || hasStageStarted ? "Extracting..." : "Run Stage 1"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setProgress(0);
                setIsRunningStage(false);
                setStageMessage("Progress cleared.");
              }}
            >
              Clear
            </Button>
          </div>

          <Button
            variant="secondary"
            onClick={handleOpenFolder}
            aria-label="Open output folder"
            title="Open output folder"
            className="h-10 w-10 p-0"
          >
            <FiFolder className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
