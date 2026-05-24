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
};

type DownloadsLibrary = {
  root: string;
  mangas: Array<{
    name: string;
    path: string;
    chapters: Array<{ name: string; path: string }>;
  }>;
};

type QueueContext = { index: number; total: number; mangaName: string } | null;

function normalizePosixPath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

function safeFolderName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  return trimmed.replace(/[\\/:"*?<>|]+/g, "_");
}

function extractMangaNameFromChapterPath(chapterPath: string, downloadsRoot: string) {
  const root = normalizePosixPath(downloadsRoot).replace(/^\.\//, "");
  const chapter = normalizePosixPath(chapterPath).replace(/^\.\//, "");
  if (!root || !chapter) return null;
  if (!chapter.startsWith(root + "/")) return null;
  const remainder = chapter.slice((root + "/").length);
  const first = remainder.split("/")[0];
  return first || null;
}

export function Stage1Extractor({ outDir = "./output", onSessionUpdate }: Props) {
  const toast = useToast();
  const [downloadsRoot, setDownloadsRoot] = useState("./downloads");
  const [library, setLibrary] = useState<DownloadsLibrary | null>(null);
  const [activeMangaPath, setActiveMangaPath] = useState<string>("");
  const [chapterFilter, setChapterFilter] = useState("");
  const [selectedChapterDirs, setSelectedChapterDirs] = useState<string[]>([]);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [chapterId, setChapterId] = useState("chapter_1");
  const [device, setDevice] = useState<"auto" | "cpu" | "mps" | "cuda">("auto");
  const [allowDownloads, setAllowDownloads] = useState(false);
  const [isRunningStage, setIsRunningStage] = useState(false);
  const [hasStageStarted, setHasStageStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("Ready to extract panels from downloaded pages.");
  const [lastOutputDir, setLastOutputDir] = useState(outDir);
  const [storyboardPath, setStoryboardPath] = useState("");
  const [storyboardPaths, setStoryboardPaths] = useState<string[]>([]);
  const [queueContext, setQueueContext] = useState<QueueContext>(null);

  const sessionState = useMemo<Stage1Session>(
    () => ({
      mangaUrl: downloadsRoot,
      totalChapters: library?.mangas.reduce((sum, manga) => sum + manga.chapters.length, 0) ?? 0,
      selectedChapters: selectedChapterDirs.length,
      progress,
      isScraping: false,
      isRunningStage,
      lastOutputDir,
      stageMessage,
    }),
    [downloadsRoot, library, progress, isRunningStage, lastOutputDir, selectedChapterDirs.length, stageMessage],
  );

  useEffect(() => {
    onSessionUpdate?.(sessionState);
  }, [onSessionUpdate, sessionState]);

  const refreshLibrary = async (nextRoot?: string) => {
    if (!window.gento?.listDownloadsLibrary) {
      setStageMessage("Desktop bridge is unavailable. Restart Electron to reload preload.");
      return;
    }
    setIsLoadingLibrary(true);
    try {
      const root = (nextRoot ?? downloadsRoot).trim() || "./downloads";
      const result = await window.gento.listDownloadsLibrary(root);
      if (!result.ok) {
        const message = formatRuntimeError(result.error.code, result.error.message, result.error.details);
        setStageMessage(message);
        toast.error("Failed to scan downloads", message);
        return;
      }
      setLibrary(result.data);
      setActiveMangaPath((current) => {
        if (current && result.data.mangas.some((manga) => manga.path === current)) {
          return current;
        }
        return result.data.mangas[0]?.path ?? "";
      });
      setStageMessage("Downloads library refreshed.");
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  useEffect(() => {
    refreshLibrary().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          setStageMessage(
            queueContext
              ? `(${queueContext.index}/${queueContext.total}) ${queueContext.mangaName}: ${payload.message}`
              : payload.message,
          );
        }
        return;
      }

      if (payload.type === "log") {
        if (payload.message) {
          setStageMessage(
            queueContext
              ? `(${queueContext.index}/${queueContext.total}) ${queueContext.mangaName}: ${payload.message}`
              : payload.message,
          );
        }
        return;
      }

      if (payload.type === "complete") {
        const summary = payload.storyboard_path ? payload.storyboard_path : "";
        const summaryPaths = Array.isArray(payload.storyboard_paths) ? payload.storyboard_paths : [];
        setStoryboardPath(summary);
        setStoryboardPaths(summaryPaths);
        setProgress(100);
        setStageMessage(payload.message ?? "Stage 1 extraction complete.");
        toast.success(
          "Stage 1 complete",
          summaryPaths.length > 0
            ? `Wrote ${summaryPaths.length} storyboards`
            : summary
              ? `Wrote ${summary}`
              : "Storyboard written.",
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

        setStageMessage(errorMessage || payload.message || "Stage 1 extraction failed.");
        toast.error("Stage 1 failed", errorMessage || payload.message || "Stage 1 extraction failed.");
        setProgress(0);
        setIsRunningStage(false);
        setHasStageStarted(false);
      }
    });

    return unsubscribe;
  }, [queueContext, toast]);

  const handleRunStage1 = async () => {
    const imagesDirs = selectedChapterDirs.map((value) => value.trim()).filter(Boolean);
    if (imagesDirs.length === 0) {
      setStageMessage("Select one or more chapter folders from Downloads first.");
      toast.error("No chapters selected", "Select at least one chapter folder to extract.");
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

    const groups = new Map<string, string[]>();
    for (const dir of imagesDirs) {
      const mangaName = extractMangaNameFromChapterPath(dir, downloadsRoot) ?? "unknown";
      groups.set(mangaName, [...(groups.get(mangaName) ?? []), dir]);
    }

    const mangaRuns = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
    const allStoryboards: string[] = [];
    const totalRuns = mangaRuns.length;

    try {
      for (let i = 0; i < mangaRuns.length; i += 1) {
        const [mangaName, chapterDirs] = mangaRuns[i];
        const safeMangaName = safeFolderName(mangaName);
        const mangaOutDir = `${normalizePosixPath(outDir)}/${safeMangaName}`;

        setQueueContext({ index: i + 1, total: totalRuns, mangaName });
        setLastOutputDir(mangaOutDir);
        setProgress(0);
        setStageMessage(`(${i + 1}/${totalRuns}) ${mangaName}: starting Stage 1 extraction...`);

        const args = buildStage1Args({
          chapterId: chapterId.trim(),
          imagesDirs: chapterDirs,
          outDir: mangaOutDir,
          device,
          allowDownloads,
        });

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
        if (complete?.storyboardPaths && complete.storyboardPaths.length > 0) {
          allStoryboards.push(...complete.storyboardPaths);
        } else if (complete?.storyboardPath) {
          allStoryboards.push(complete.storyboardPath);
        }
      }

      if (allStoryboards.length > 1) {
        setStoryboardPaths(allStoryboards);
        setStoryboardPath("");
        setProgress(100);
        setStageMessage(`Stage 1 complete: wrote ${allStoryboards.length} storyboards.`);
        toast.success("Stage 1 complete", `Wrote ${allStoryboards.length} storyboards`);
      } else if (allStoryboards.length === 1) {
        setStoryboardPath(allStoryboards[0]);
        setStoryboardPaths([]);
        setProgress(100);
        setStageMessage(`Stage 1 complete: ${allStoryboards[0]}`);
        toast.success("Stage 1 complete", `Wrote ${allStoryboards[0]}`);
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
      setQueueContext(null);
      setIsRunningStage(false);
      setHasStageStarted(false);
    }
  };

  const handleOpenOutputFolder = async () => {
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

  const handleOpenDownloadsFolder = async () => {
    if (!window.gento?.openPath) {
      setStageMessage("Desktop bridge is unavailable. Restart Electron to reload preload.");
      return;
    }
    const result = await window.gento.openPath(downloadsRoot);
    if (!result.ok) {
      const message = `Failed to open folder: ${result.error.message}`;
      setStageMessage(message);
      toast.error("Open folder failed", result.error.message);
    }
  };

  const activeManga = useMemo(() => {
    return library?.mangas.find((manga) => manga.path === activeMangaPath) ?? null;
  }, [activeMangaPath, library]);

  const visibleChapters = useMemo(() => {
    const chapters = activeManga?.chapters ?? [];
    const filter = chapterFilter.trim().toLowerCase();
    if (!filter) return chapters;
    return chapters.filter((chapter) => chapter.name.toLowerCase().includes(filter));
  }, [activeManga, chapterFilter]);

  const toggleChapterSelection = (chapterDir: string) => {
    setSelectedChapterDirs((current) =>
      current.includes(chapterDir) ? current.filter((value) => value !== chapterDir) : [...current, chapterDir],
    );
  };

  const removeSelectedChapter = (chapterDir: string) => {
    setSelectedChapterDirs((current) => current.filter((value) => value !== chapterDir));
  };

  const clearSelectedChapters = () => setSelectedChapterDirs([]);

  return (
    <Card className="lg:flex lg:flex-col lg:min-h-0 lg:h-full">
      <CardHeader className="border-b border-border/60 p-5">
        <CardTitle>Stage 1 Extractor</CardTitle>
        <CardDescription>
          Run Magi panel extraction and write storyboard.json from downloaded images.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Downloads library
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={downloadsRoot}
              onChange={(event) => setDownloadsRoot(event.target.value)}
              placeholder="./downloads"
              className="glass-interactive h-10 min-w-[240px] flex-1 rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground border"
            />
            <Button
              variant="secondary"
              onClick={() => refreshLibrary(downloadsRoot)}
              disabled={isLoadingLibrary}
              className="shrink-0"
            >
              {isLoadingLibrary ? "Refreshing..." : "Refresh"}
            </Button>
            <Button variant="secondary" onClick={handleOpenDownloadsFolder} className="shrink-0">
              Open
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Select chapters from multiple manga. Selections persist as you browse.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Manga
            </label>
            <div className="glass-surface max-h-56 overflow-y-auto rounded-2xl border border-border/60 p-2">
              {library?.mangas?.length ? (
                <div className="space-y-1">
                  {library.mangas.map((manga) => (
                    <button
                      key={manga.path}
                      type="button"
                      onClick={() => setActiveMangaPath(manga.path)}
                      className={`w-full rounded-xl px-3 py-2 text-left text-sm ${
                        manga.path === activeMangaPath
                          ? "bg-accent/70 text-foreground"
                          : "hover:bg-accent/40 text-muted-foreground"
                      }`}
                    >
                      <span className="truncate">{manga.name}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  No downloads found in {downloadsRoot}.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Chapters {activeManga ? `(${activeManga.name})` : ""}
              </label>
              <input
                type="text"
                value={chapterFilter}
                onChange={(event) => setChapterFilter(event.target.value)}
                placeholder="Filter…"
                className="glass-interactive h-8 w-40 rounded-xl px-3 text-xs text-foreground outline-none placeholder:text-muted-foreground border"
              />
            </div>
            <div className="glass-surface max-h-56 overflow-y-auto rounded-2xl border border-border/60 p-2">
              {activeManga?.chapters?.length ? (
                <div className="space-y-1">
                  {visibleChapters.map((chapter) => {
                    const checked = selectedChapterDirs.includes(chapter.path);
                    return (
                      <label
                        key={chapter.path}
                        className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm hover:bg-accent/40"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleChapterSelection(chapter.path)}
                          className="h-4 w-4 accent-black"
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">{chapter.name}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="px-2 py-2 text-sm text-muted-foreground">Select a manga to see chapters.</p>
              )}
            </div>
          </div>
        </div>

        {selectedChapterDirs.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Selected chapters ({selectedChapterDirs.length})
              </label>
              <Button variant="secondary" size="sm" onClick={clearSelectedChapters}>
                Clear selection
              </Button>
            </div>
            <div className="glass-surface max-h-44 overflow-y-auto rounded-2xl border border-border/60 p-2">
              <div className="space-y-1">
                {selectedChapterDirs.map((dir) => (
                  <div key={dir} className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm hover:bg-accent/40">
                    <span className="min-w-0 flex-1 truncate text-foreground">{dir}</span>
                    <Button variant="secondary" size="sm" onClick={() => removeSelectedChapter(dir)}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

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
              value={`${normalizePosixPath(outDir)}/<manga_name>/final`}
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

        {storyboardPaths.length > 0 ? (
          <div className="rounded-2xl border border-border/50 bg-background/80 p-3 text-sm text-muted-foreground">
            <p>Storyboards:</p>
            <ul className="mt-2 space-y-1">
              {storyboardPaths.map((path) => (
                <li key={path} className="truncate text-foreground">
                  {path}
                </li>
              ))}
            </ul>
          </div>
        ) : storyboardPath ? (
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
                setHasStageStarted(false);
                setQueueContext(null);
                setStageMessage("Progress cleared.");
              }}
            >
              Clear
            </Button>
          </div>

          <Button
            variant="secondary"
            onClick={handleOpenOutputFolder}
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
