import { describe, it, expect } from "vitest";
import {
  buildStage0Args,
  extractChaptersFromEvents,
  extractCompleteSummary,
  extractLastPercent,
} from "./stage0";

describe("stage0 helpers", () => {
  it("extracts chapters from complete events", () => {
    const events = [
      { type: "progress", stage: 1, percent: 5 },
      {
        type: "complete",
        stage: 1,
        chapters: [{ name: "Chapter 1", url: "https://example.com/1" }],
      },
    ];

    expect(extractChaptersFromEvents(events)).toEqual([
      { name: "Chapter 1", url: "https://example.com/1" },
    ]);
  });

  it("returns the last progress percent", () => {
    const events = [
      { type: "progress", stage: 1, percent: 10 },
      { type: "progress", stage: 2, percent: 80 },
      { type: "complete", stage: 2 },
    ];

    expect(extractLastPercent(events)).toBe(80);
  });

  it("returns null when no progress is present", () => {
    expect(extractLastPercent([{ type: "complete", stage: 0 }])).toBeNull();
  });

  it("extracts complete summary from the first complete event", () => {
    const events = [
      { type: "progress", stage: 0, percent: 20 },
      {
        type: "complete",
        stage: 0,
        output_dir: "out",
        downloaded_chapters: 5,
      },
    ];

    expect(extractCompleteSummary(events)).toEqual({
      outputDir: "out",
      downloadedChapters: 5,
    });
  });

  it("returns null when no complete event exists", () => {
    expect(extractCompleteSummary([{ type: "progress", stage: 0, percent: 100 }])).toBeNull();
  });

  it("builds details-only arguments", () => {
    expect(
      buildStage0Args({
        url: "https://manga.example",
        outDir: "./out",
        detailsOnly: true,
      }),
    ).toEqual(["--url", "https://manga.example", "--out", "./out", "--details-only"]);
  });

  it("includes chapters json and format arguments", () => {
    expect(
      buildStage0Args({
        url: "https://manga.example",
        outDir: "./out",
        chapters: [{ name: "Ch 1", url: "https://example.com/1" }],
        format: "cbz",
      }),
    ).toEqual([
      "--url",
      "https://manga.example",
      "--out",
      "./out",
      "--chapters-json",
      JSON.stringify([{ name: "Ch 1", url: "https://example.com/1" }]),
      "--format",
      "cbz",
    ]);
  });

  it("adds delete-images only for pdf or cbz formats", () => {
    expect(
      buildStage0Args({
        url: "https://manga.example",
        outDir: "./out",
        format: "cbz",
        deleteImages: true,
      }),
    ).toContain("--delete-images");

    expect(
      buildStage0Args({
        url: "https://manga.example",
        outDir: "./out",
        format: "none",
        deleteImages: true,
      }),
    ).not.toContain("--delete-images");
  });
});
