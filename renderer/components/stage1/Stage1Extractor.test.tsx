import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Stage1Extractor } from "./Stage1Extractor";
import { STAGE1_MODEL } from "@/lib/stage1";

declare global {
  interface Window {
    gento?: {
      runStage?: (stage: number, args: string[]) => Promise<any>;
      openPath?: (path: string) => Promise<any>;
      onStageEvent?: (callback: (payload: any) => void) => () => void;
    };
  }
}

function renderIntoDocument(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function getProgressValue(container: HTMLElement) {
  const progressbar = container.querySelector('[role="progressbar"]') as HTMLElement | null;
  return progressbar?.getAttribute("aria-valuenow");
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setReactInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Stage1Extractor", () => {
  it("renders the fixed model id as read-only", () => {
    window.gento = {};
    const { container, root } = renderIntoDocument(<Stage1Extractor outDir="./output" />);

    const modelInput = container.querySelector(`input[readonly][value="${STAGE1_MODEL}"]`);
    expect(modelInput).not.toBeNull();

    act(() => root.unmount());
  });

  it("updates progress + message from stage events (progress/log/complete/error)", () => {
    const listener = vi.fn();
    window.gento = {
      onStageEvent: (cb) => {
        listener.mockImplementation(cb);
        return () => {};
      },
      openPath: vi.fn(async () => ({ ok: true, data: { path: "/tmp" }, error: null })),
      runStage: vi.fn(async () => ({ ok: true, data: { events: [] }, error: null })),
    };

    const { container, root } = renderIntoDocument(<Stage1Extractor outDir="./output" />);

    act(() => {
      listener({ type: "progress", stage: 1, percent: 42, message: "Working..." });
    });
    expect(container.textContent).toContain("Working...");
    expect(getProgressValue(container)).toBe("42");

    act(() => {
      listener({ type: "log", stage: 1, message: "hello" });
    });
    expect(container.textContent).toContain("hello");

    act(() => {
      listener({ type: "complete", stage: 1, storyboard_path: "/tmp/storyboard.json" });
    });
    expect(container.textContent).toContain("Stage 1 extraction complete.");
    expect(getProgressValue(container)).toBe("100");
    expect(container.textContent).toContain("/tmp/storyboard.json");

    act(() => {
      listener({ type: "error", stage: 1, error: { code: "X", message: "Boom" } });
    });
    expect(container.textContent).toContain("Boom");
    expect(getProgressValue(container)).toBe("0");

    act(() => root.unmount());
  });

  it("validates required inputs before running", async () => {
    window.gento = {
      runStage: vi.fn(async () => ({ ok: true, data: { events: [] }, error: null })),
    };
    const { container, root } = renderIntoDocument(<Stage1Extractor outDir="./output" />);

    const imagesInput = container.querySelector('input[placeholder="./downloads/Your Manga/Chapter 1"]') as
      | HTMLInputElement
      | null;
    const chapterInput = container.querySelector('input[placeholder="chapter_1"]') as HTMLInputElement | null;
    const runButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Run Stage 1"),
    ) as HTMLButtonElement | undefined;

    expect(imagesInput).not.toBeNull();
    expect(chapterInput).not.toBeNull();
    expect(runButton).toBeTruthy();

    act(() => {
      setReactInputValue(imagesInput!, "");
    });
    await tick();
    act(() => runButton!.click());
    await tick();
    expect(container.textContent).toContain("Please provide the downloaded images folder.");

    act(() => {
      setReactInputValue(imagesInput!, "./downloads");
      setReactInputValue(chapterInput!, "");
    });
    await tick();
    act(() => runButton!.click());
    await tick();
    expect(container.textContent).toContain("Please provide a chapter ID.");

    act(() => root.unmount());
  });

  it("calls runStage(1) with fixed model args and marks progress 100 on success", async () => {
    const runStage = vi.fn(async () => ({
      ok: true,
      data: {
        events: [
          { type: "progress", stage: 1, percent: 80, message: "Processing..." },
          { type: "complete", stage: 1, storyboard_path: "output/final/storyboard.json" },
        ],
      },
      error: null,
    }));
    window.gento = { runStage };

    const { container, root } = renderIntoDocument(<Stage1Extractor outDir="output" />);
    const runButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Run Stage 1"),
    ) as HTMLButtonElement | undefined;
    expect(runButton).toBeTruthy();

    await act(async () => {
      runButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(runStage).toHaveBeenCalledTimes(1);
    const [stage, args] = runStage.mock.calls[0];
    expect(stage).toBe(1);
    expect(args).toContain("--model");
    expect(args).toContain(STAGE1_MODEL);
    expect(container.textContent).toContain("Stage 1 complete:");
    expect(getProgressValue(container)).toBe("100");

    act(() => root.unmount());
  });

  it("shows formatted error message when runStage returns ok=false", async () => {
    window.gento = {
      runStage: vi.fn(async () => ({
        ok: false,
        data: null,
        error: { code: "PROCESS_EXIT_NON_ZERO", message: "bad", details: { stderr: "No module named 'torch'" } },
      })),
    };

    const { container, root } = renderIntoDocument(<Stage1Extractor outDir="output" />);
    const runButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Run Stage 1"),
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      runButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Python dependency missing: torch");
    expect(getProgressValue(container)).toBe("0");

    act(() => root.unmount());
  });

  it("opens output folder and reports failures", async () => {
    const openPath = vi.fn(async () => ({ ok: false, data: null, error: { code: "X", message: "Nope" } }));
    window.gento = { openPath };

    const { container, root } = renderIntoDocument(<Stage1Extractor outDir="/tmp/out" />);
    const openButton = container.querySelector('button[aria-label="Open output folder"]') as HTMLButtonElement | null;
    expect(openButton).not.toBeNull();

    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openPath).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Failed to open folder:");

    act(() => root.unmount());
  });

  it("clears progress", async () => {
    let stageListener: ((payload: any) => void) | null = null;
    window.gento = {
      onStageEvent: (cb) => {
        stageListener = cb;
        return () => {};
      },
    };

    const { container, root } = renderIntoDocument(<Stage1Extractor outDir="./output" />);

    act(() => {
      stageListener?.({ type: "progress", stage: 1, percent: 50, message: "Halfway" });
    });
    expect(getProgressValue(container)).toBe("50");

    const clearButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Clear"),
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(getProgressValue(container)).toBe("0");
    expect(container.textContent).toContain("Progress cleared.");

    act(() => root.unmount());
  });
});
