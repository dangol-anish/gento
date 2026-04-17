import { describe, it, expect } from "vitest";
import { formatRuntimeError } from "./runtimeErrors";

describe("formatRuntimeError", () => {
  it("returns stage-specific error when present", () => {
    const result = formatRuntimeError("PROCESS_EXIT_NON_ZERO", "failed", {
      events: [
        { type: "error", error: { details: { reason: "missing page" } } },
      ],
    });

    expect(result).toBe("Scrape failed: missing page");
  });

  it("returns a python dependency message for missing httpx", () => {
    const result = formatRuntimeError("PROCESS_EXIT_NON_ZERO", "failed", {
      stderr: "ModuleNotFoundError: No module named 'httpx'",
    });

    expect(result).toContain("Python dependency missing: httpx");
  });

  it("returns a python dependency message for missing pillow", () => {
    const result = formatRuntimeError("PROCESS_EXIT_NON_ZERO", "failed", {
      stderr: "ModuleNotFoundError: No module named 'PIL'",
    });

    expect(result).toContain("Python dependency missing: pillow");
  });

  it("returns a generic missing module message with stderr details", () => {
    const stderr = "ModuleNotFoundError: No module named 'something'\nTraceback (most recent call last): ...";
    const result = formatRuntimeError("PROCESS_EXIT_NON_ZERO", "failed", { stderr });

    expect(result).toContain("Python dependency missing. Run `python3 -m pip install -r requirements.txt` and retry.");
    expect(result).toContain("No module named 'something'");
  });

  it("returns the fallback message when code is not a known failure", () => {
    const result = formatRuntimeError("UNKNOWN_ERROR", "failed", { stderr: "oops" });
    expect(result).toBe("[UNKNOWN_ERROR] failed");
  });
});
