import { describe, expect, it } from "vitest";

import {
  buildStage5Args,
  extractCompleteSummary,
  extractLastPercent,
} from "./stage5";

describe("stage5", () => {
  it("buildStage5Args builds args and optional flags", () => {
    const args = buildStage5Args({
      refinedRecapPagesPath: "./output/final/recap_pages_with_sentences.json",
      outDir: "./output/final/audio",
      outJson: "./output/final/final_script.json",
      voice: "am_echo",
      speed: 1.1,
      timingTts: true,
    });
    expect(args).toEqual([
      "./output/final/recap_pages_with_sentences.json",
      "--out-dir",
      "./output/final/audio",
      "--out-json",
      "./output/final/final_script.json",
      "--voice",
      "am_echo",
      "--speed",
      "1.1",
      "--timing-tts",
    ]);
  });

  it("extractLastPercent returns last progress percent", () => {
    const events: any[] = [
      { type: "progress", percent: 5 },
      { type: "progress", percent: 15 },
    ];
    expect(extractLastPercent(events as any)).toBe(15);
  });

  it("extractCompleteSummary reads output paths", () => {
    const events: any[] = [
      { type: "progress", percent: 5 },
      {
        type: "complete",
        stitched_audio_path: "a.wav",
        final_script_path: "final.json",
        audio_dir: "audio/",
      },
    ];
    expect(extractCompleteSummary(events as any)).toEqual({
      stitchedAudioPath: "a.wav",
      finalScriptPath: "final.json",
      audioDir: "audio/",
    });
  });
});
