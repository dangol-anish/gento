import { buildStage7Args, extractCompleteSummary } from "./stage7";

describe("stage7", () => {
  it("builds args from input paths", () => {
    const args = buildStage7Args({ inputPaths: ["./output/Manga A/final/final_script.json", "./output/Manga B/final_1/final_script.json"] });
    expect(args).toEqual(["./output/Manga A/final/final_script.json", "./output/Manga B/final_1/final_script.json"]);
  });

  it("extracts output paths from complete events", () => {
    const events = [
      { type: "log", message: "starting" },
      { type: "complete", stage: 7, output_paths: ["./output/Manga A/final/final_script_trimmed.json"] },
    ];
    const summary = extractCompleteSummary(events as any);
    expect(summary).toEqual({ outputPaths: ["./output/Manga A/final/final_script_trimmed.json"] });
  });
});
