import { buildStage8Args, extractCompleteSummary } from "./stage8";

describe("stage8", () => {
  it("builds args from shorts JSON paths and flags", () => {
    const args = buildStage8Args({
      shortsJson: ["./output/Manga/shorts.json", "./output/Manga/shorts_alt.json"],
      outputRoot: "./output",
      voice: "am_echo",
      speed: 1.25,
      sampleRate: 22050,
    });

    expect(args).toEqual([
      "./output/Manga/shorts.json",
      "./output/Manga/shorts_alt.json",
      "--output-root",
      "./output",
      "--voice",
      "am_echo",
      "--speed",
      "1.25",
      "--sample-rate",
      "22050",
    ]);
  });

  it("extracts complete summary from stage events", () => {
    const events = [
      { type: "progress", percent: 50, message: "Halfway" },
      {
        type: "complete",
        stage: 8,
        output_audio: "./output/Manga/shorts/narration.wav",
        output_dir: "./output/Manga/shorts",
        copied_panels: ["./output/Manga/shorts/Chapter 1/panel.png"],
        missing_panel_paths: ["Chapter 1/panel999.png"],
      },
    ];

    expect(extractCompleteSummary(events as any)).toEqual({
      outputAudio: "./output/Manga/shorts/narration.wav",
      outputDir: "./output/Manga/shorts",
      copiedPanels: ["./output/Manga/shorts/panels/panel_0001.png"],
      missingPanelPaths: ["Chapter 1/panel999.png"],
    });
  });
});
