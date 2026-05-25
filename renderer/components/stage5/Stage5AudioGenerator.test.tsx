import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Stage5AudioGenerator } from "./Stage5AudioGenerator";

declare global {
  interface Window {
    gento?: {
      listOutputLibrary?: (root?: string) => Promise<any>;
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Stage5AudioGenerator (batch queue)", () => {
  it("queues runStage(5) per selected run", async () => {
    const runStage = vi.fn(async () => ({
      ok: true,
      data: { events: [{ type: "complete", stage: 5, final_script_path: "x" }] },
      error: null,
    }));

    window.gento = {
      listOutputLibrary: vi.fn(async () => ({
        ok: true,
        data: {
          root: "./output",
          mangas: [
            {
              name: "Manga A",
              path: "./output/Manga A",
              runs: [
                {
                  name: "final",
                  path: "./output/Manga A/final",
                  recap_pages_path: null,
                  refined_recap_path: "./output/Manga A/final/recap_pages_with_sentences.json",
                  storyboard_path: "./output/Manga A/final/storyboard.json",
                },
              ],
            },
            {
              name: "Manga B",
              path: "./output/Manga B",
              runs: [
                {
                  name: "final_1",
                  path: "./output/Manga B/final_1",
                  recap_pages_path: null,
                  refined_recap_path: "./output/Manga B/final_1/recap_pages_with_sentences.json",
                  storyboard_path: "./output/Manga B/final_1/storyboard.json",
                },
              ],
            },
          ],
        },
        error: null,
      })),
      runStage,
      onStageEvent: () => () => {},
    };

    const { container, root } = renderIntoDocument(<Stage5AudioGenerator />);
    await tick();
    await tick();

    const selectRunCheckbox = async (runName: string) => {
      const runLabel = Array.from(container.querySelectorAll("label")).find((label) =>
        label.textContent?.includes(runName),
      ) as HTMLLabelElement | undefined;
      expect(runLabel).toBeTruthy();
      const checkbox = runLabel!.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(checkbox).not.toBeNull();
      act(() => checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await tick();
    };

    const mangaBButton = Array.from(container.querySelectorAll('button[type="button"]')).find((btn) =>
      btn.textContent?.includes("Manga B"),
    ) as HTMLButtonElement | undefined;
    expect(mangaBButton).toBeTruthy();

    await selectRunCheckbox("final");
    act(() => mangaBButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    await selectRunCheckbox("final_1");

    const runButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Run Stage 5"),
    ) as HTMLButtonElement | undefined;
    expect(runButton).toBeTruthy();

    await act(async () => {
      runButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });

    expect(runStage).toHaveBeenCalledTimes(2);
    expect(runStage.mock.calls.map((call) => call[0])).toEqual([5, 5]);

    const argsA = runStage.mock.calls[0][1] as string[];
    expect(argsA[0]).toBe("./output/Manga A/final/recap_pages_with_sentences.json");
    const argsB = runStage.mock.calls[1][1] as string[];
    expect(argsB[0]).toBe("./output/Manga B/final_1/recap_pages_with_sentences.json");

    act(() => root.unmount());
  });
});

