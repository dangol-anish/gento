import { useMemo, useState } from "react";

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
import { ChapterPicker } from "@/components/stage0/ChapterPicker";
import { DownloadOptions } from "@/components/stage0/DownloadOptions";
import { formatRuntimeError } from "@/lib/runtimeErrors";
import {
  type Chapter,
  buildStage0Args,
  extractChaptersFromEvents,
  extractCompleteSummary,
  extractLastPercent,
} from "@/lib/stage0";

type Props = {
  outDir?: string;
};

export function Stage0Downloader({ outDir = "./downloads" }: Props) {
  const [progress, setProgress] = useState(0);
  const [mangaUrl, setMangaUrl] = useState("");
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapterUrls, setSelectedChapterUrls] = useState<Set<string>>(
    new Set(),
  );
  const [isScraping, setIsScraping] = useState(false);
  const [isRunningStage, setIsRunningStage] = useState(false);
  const [stageMessage, setStageMessage] = useState(
    "Ready to scrape manga details.",
  );
  const [downloadFormat, setDownloadFormat] = useState<"none" | "pdf" | "cbz">(
    "none",
  );
  const [deleteImages, setDeleteImages] = useState(false);
  const [rangeStart, setRangeStart] = useState("1");
  const [rangeEnd, setRangeEnd] = useState("1");
  const [lastOutputDir, setLastOutputDir] = useState(outDir);

  const selectedChapters = useMemo(
    () => chapters.filter((chapter) => selectedChapterUrls.has(chapter.url)),
    [chapters, selectedChapterUrls],
  );
  const allSelected =
    chapters.length > 0 && selectedChapterUrls.size === chapters.length;

  const toggleChapter = (url: string) => {
    setSelectedChapterUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) {
        next.delete(url);
      } else {
        next.add(url);
      }
      return next;
    });
  };

  const selectAllChapters = () => {
    setSelectedChapterUrls(new Set(chapters.map((chapter) => chapter.url)));
  };

  const clearChapterSelection = () => {
    setSelectedChapterUrls(new Set());
  };

  const applyRangeSelection = () => {
    if (chapters.length === 0) return;
    const start = Number.parseInt(rangeStart, 10);
    const end = Number.parseInt(rangeEnd, 10);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      setStageMessage("Range values must be valid numbers.");
      return;
    }

    const safeStart = Math.max(1, Math.min(start, chapters.length));
    const safeEnd = Math.max(safeStart, Math.min(end, chapters.length));
    const ranged = chapters
      .slice(safeStart - 1, safeEnd)
      .map((chapter) => chapter.url);
    setSelectedChapterUrls(new Set(ranged));
    setStageMessage(`Selected chapters ${safeStart} to ${safeEnd}.`);
  };

  const handleScrapeManga = async () => {
    if (!mangaUrl.trim()) {
      setStageMessage("Please provide a MangaBuddy URL.");
      return;
    }

    setIsScraping(true);
    setStageMessage("Scraping manga details...");

    try {
      if (!window.gento) {
        setStageMessage(
          "Desktop bridge is unavailable. Restart Electron to reload preload.",
        );
        return;
      }

      let chaptersResult: Chapter[] = [];

      if (typeof window.gento.scrapeManga === "function") {
        const result = await window.gento.scrapeManga(mangaUrl.trim(), outDir);
        if (!result.ok) {
          setStageMessage(
            formatRuntimeError(
              result.error.code,
              result.error.message,
              result.error.details,
            ),
          );
          return;
        }
        chaptersResult = result.data.chapters || [];
      } else {
        const result = await window.gento.runStage(
          0,
          buildStage0Args({ url: mangaUrl.trim(), outDir, detailsOnly: true }),
        );
        if (!result.ok) {
          setStageMessage(
            formatRuntimeError(
              result.error.code,
              result.error.message,
              result.error.details,
            ),
          );
          return;
        }
        chaptersResult = extractChaptersFromEvents(
          (result.data?.events || []) as any,
        );
      }

      setChapters(chaptersResult);
      setSelectedChapterUrls(
        new Set(chaptersResult.map((chapter) => chapter.url)),
      );
      setRangeStart("1");
      setRangeEnd(String(Math.max(1, chaptersResult.length)));
      setProgress(0);
      setStageMessage(
        `Scrape complete. Found ${chaptersResult.length} chapters.`,
      );
    } catch (error) {
      setStageMessage(`Scrape failed: ${(error as Error).message}`);
    } finally {
      setIsScraping(false);
    }
  };

  const handleRunStage0 = async () => {
    if (!mangaUrl.trim()) {
      setStageMessage("Please provide a MangaBuddy URL.");
      return;
    }
    if (selectedChapters.length === 0) {
      setStageMessage("Select at least one chapter before downloading.");
      return;
    }
    if (!window.gento || typeof window.gento.runStage !== "function") {
      setStageMessage(
        "Desktop bridge is unavailable. Restart Electron to reload preload.",
      );
      return;
    }

    setIsRunningStage(true);
    setProgress(5);
    setStageMessage("Running Stage 0 download...");

    try {
      const args = buildStage0Args({
        url: mangaUrl.trim(),
        outDir,
        chapters: selectedChapters,
        format: downloadFormat,
        deleteImages,
      });

      const result = await window.gento.runStage(0, args);
      if (!result.ok) {
        setStageMessage(
          formatRuntimeError(
            result.error.code,
            result.error.message,
            result.error.details,
          ),
        );
        setProgress(0);
        return;
      }

      const events = (result.data?.events || []) as any[];
      const lastPercent = extractLastPercent(events as any);
      if (lastPercent !== null) {
        setProgress(lastPercent);
      }

      const complete = extractCompleteSummary(events as any);
      if (complete) {
        setProgress(100);
        setLastOutputDir(complete.outputDir || outDir);
        setStageMessage(
          `Downloaded ${complete.downloadedChapters || selectedChapters.length} chapters to ${complete.outputDir || outDir}.`,
        );
      } else {
        setStageMessage("Stage completed.");
      }
    } catch (error) {
      setStageMessage(`Download failed: ${(error as Error).message}`);
      setProgress(0);
    } finally {
      setIsRunningStage(false);
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
      setStageMessage(`Failed to open folder: ${result.error.message}`);
    }
  };

  return (
    <Card className=" lg:flex lg:flex-col lg:min-h-0 lg:h-full">
      <CardHeader className="border-b border-border/60 p-5">
        <CardTitle>Stage 0 Downloader</CardTitle>
        <CardDescription>
          Scrape chapters and download selected ones from MangaBuddy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 p-5 pt-2 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Manga URL
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={mangaUrl}
              onChange={(event) => setMangaUrl(event.target.value)}
              placeholder="https://mangabuddy.com/your-manga"
              className="glass-interactive h-10 w-full rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <Button
              variant="secondary"
              onClick={handleScrapeManga}
              disabled={isScraping}
            >
              {isScraping ? "Scraping..." : "Scrape"}
            </Button>
          </div>
        </div>

        <ChapterPicker
          chapters={chapters}
          selectedChapterUrls={selectedChapterUrls}
          allSelected={allSelected}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          setRangeStart={setRangeStart}
          setRangeEnd={setRangeEnd}
          onSelectAll={selectAllChapters}
          onClear={clearChapterSelection}
          onApplyRange={applyRangeSelection}
          onToggleChapter={toggleChapter}
        />

        <DownloadOptions
          downloadFormat={downloadFormat}
          setDownloadFormat={setDownloadFormat}
          deleteImages={deleteImages}
          setDeleteImages={setDeleteImages}
        />

        <Progress value={progress} />
        <p className="text-sm text-muted-foreground/90">{stageMessage}</p>
        <div className="flex justify-between items-center">
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleRunStage0}
              disabled={isRunningStage || chapters.length === 0}
            >
              {isRunningStage ? "Downloading..." : "Download Selected"}
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
            aria-label="Open download folder"
            title="Open download folder"
            className="h-10 w-10 p-0"
          >
            <FiFolder className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
