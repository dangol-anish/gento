import { describe, expect, it } from "vitest";
import { STAGE1_MODEL, buildStage1Args, extractCompleteSummary, extractLastPercent } from "./stage1";

describe("stage1 lib", () => {
  it("uses a fixed model id", () => {
    expect(STAGE1_MODEL).toBe("ragavsachdeva/magiv3");
  });

  it("buildStage1Args always uses the fixed model and includes optional flags", () => {
    const args = buildStage1Args({
      chapterId: "chapter_1",
      imagesDirs: ["/tmp/images"],
      outDir: "/tmp/out",
      device: "cpu",
      allowDownloads: true,
      debug: true,
    });

    expect(args).toEqual([
      "--chapter-id",
      "chapter_1",
      "--images",
      "/tmp/images",
      "--out",
      "/tmp/out",
      "--device",
      "cpu",
      "--model",
      "ragavsachdeva/magiv3",
      "--allow-downloads",
      "--debug",
    ]);
  });

  it("extractLastPercent returns the last progress percent", () => {
    expect(
      extractLastPercent([
        { type: "progress", percent: 10 },
        { type: "log", message: "hi" },
        { type: "progress", percent: 80 },
      ]),
    ).toBe(80);
  });

  it("extractCompleteSummary returns storyboard path", () => {
    expect(
      extractCompleteSummary([
        { type: "progress", percent: 10 },
        { type: "complete", storyboard_path: "/tmp/storyboard.json" },
      ]),
    ).toEqual({ storyboardPath: "/tmp/storyboard.json", storyboardPaths: undefined });
  });
});
