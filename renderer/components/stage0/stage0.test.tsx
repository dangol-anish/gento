import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { Stage0Downloader } from "./Stage0Downloader";
import { ChapterPicker } from "./ChapterPicker";
import { DownloadOptions } from "./DownloadOptions";

function renderIntoDocument(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Stage0Downloader", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete (window as any).gento;
  });

  it("shows validation when scrape is clicked without a URL", async () => {
    const { container } = renderIntoDocument(<Stage0Downloader />);
    const scrapeButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Scrape"),
    );

    act(() => {
      scrapeButton?.click();
    });

    await tick();

    expect(container.textContent).toContain("Please provide a manga URL (MangaDex or MangaBuddy).");
  });

  it("renders the downloader layout and shows the default scrape message", () => {
    const { container } = renderIntoDocument(<Stage0Downloader />);

    expect(container.textContent).toContain("Stage 0 Downloader");
    expect(container.textContent).toContain("Scrape manga to load chapter list.");
    expect(container.textContent).toContain("Download Selected");
  });

  it("updates progress and stage status from live stage events", async () => {
    const onStageEvent = vi.fn((callback) => {
      callback({
        type: "progress",
        stage: 0,
        percent: 37,
        message: "Downloading chapters...",
      });
      callback({
        type: "complete",
        stage: 0,
        output_dir: "./downloads",
        downloaded_chapters: 2,
      });
      return () => {};
    });

    (window as any).gento = {
      onStageEvent,
    };

    const { container } = renderIntoDocument(<Stage0Downloader />);

    await tick();

    expect(container.textContent).toContain("Stage 0 complete.");
    expect(container.textContent).toContain("100%");
  });
});

describe("ChapterPicker", () => {
  it("renders chapter buttons and applies actions for selection", () => {
    const onSelectAll = vi.fn();
    const onClear = vi.fn();
    const onApplyRange = vi.fn();
    const onToggleChapter = vi.fn();
    const setRangeStart = vi.fn();
    const setRangeEnd = vi.fn();

    const { container } = renderIntoDocument(
      <ChapterPicker
        chapters={[
          { name: "Chapter 1", url: "https://example.com/1" },
          { name: "Chapter 2", url: "https://example.com/2" },
        ]}
        selectedChapterUrls={new Set(["https://example.com/1"])}
        allSelected={false}
        rangeStart="1"
        rangeEnd="2"
        setRangeStart={setRangeStart}
        setRangeEnd={setRangeEnd}
        onSelectAll={onSelectAll}
        onClear={onClear}
        onApplyRange={onApplyRange}
        onToggleChapter={onToggleChapter}
      />,
    );

    const selectAllButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Select All"),
    );
    const clearButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Clear"),
    );
    const applyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Apply"),
    );
    const chapterButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Chapter 2"),
    );

    act(() => {
      selectAllButton?.click();
      clearButton?.click();
      applyButton?.click();
      chapterButton?.click();
    });

    expect(onSelectAll).toHaveBeenCalled();
    expect(onClear).toHaveBeenCalled();
    expect(onApplyRange).toHaveBeenCalled();
    expect(onToggleChapter).toHaveBeenCalledWith("https://example.com/2");
  });

  it("shows a placeholder message when there are no chapters", () => {
    const { container } = renderIntoDocument(
      <ChapterPicker
        chapters={[]}
        selectedChapterUrls={new Set()}
        allSelected={false}
        rangeStart="1"
        rangeEnd="1"
        setRangeStart={() => {}}
        setRangeEnd={() => {}}
        onSelectAll={() => {}}
        onClear={() => {}}
        onApplyRange={() => {}}
        onToggleChapter={() => {}}
      />,
    );

    expect(container.textContent).toContain("Scrape manga to load chapter list.");
  });
});

describe("DownloadOptions", () => {
  it("renders format buttons and toggles delete images state", () => {
    const setDownloadFormat = vi.fn();
    const setDeleteImages = vi.fn();

    const { container } = renderIntoDocument(
      <DownloadOptions
        downloadFormat="none"
        setDownloadFormat={setDownloadFormat}
        deleteImages={false}
        setDeleteImages={setDeleteImages}
      />,
    );

    const pdfButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("PDF"),
    );
    const cbzButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("CBZ"),
    );
    const checkbox = container.querySelector("input[type=checkbox]") as HTMLInputElement;

    act(() => {
      pdfButton?.click();
      cbzButton?.click();
      checkbox?.click();
    });

    expect(setDownloadFormat).toHaveBeenCalledWith("pdf");
    expect(setDownloadFormat).toHaveBeenCalledWith("cbz");
    expect(checkbox.disabled).toBe(true);
  });
});
