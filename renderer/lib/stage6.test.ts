import { describe, expect, it } from "vitest";

import { buildStage6Args, extractCompleteSummary, extractLastPercent } from "./stage6";

describe("stage6", () => {
  it("buildStage6Args builds args and optional flags", () => {
    const args = buildStage6Args({
      finalScriptPath: "./output/final/final_script.json",
      outMp4: "./output/final/video.mp4",
      fps: 30,
      width: 1280,
      height: 720,
      crf: 20,
      preset: "fast",
      noAudio: true,
      overwrite: true,
    });
    expect(args).toEqual([
      "./output/final/final_script.json",
      "--out-mp4",
      "./output/final/video.mp4",
      "--fps",
      "30",
      "--width",
      "1280",
      "--height",
      "720",
      "--crf",
      "20",
      "--preset",
      "fast",
      "--no-audio",
      "--overwrite",
    ]);
  });

  it("extractLastPercent returns last progress percent", () => {
    const events: any[] = [
      { type: "progress", percent: 5 },
      { type: "progress", percent: 42 },
    ];
    expect(extractLastPercent(events as any)).toBe(42);
  });

  it("extractCompleteSummary reads output paths", () => {
    const events: any[] = [
      { type: "complete", video_path: "video.mp4" },
    ];
    expect(extractCompleteSummary(events as any)).toEqual({ videoPath: "video.mp4" });
  });
});

