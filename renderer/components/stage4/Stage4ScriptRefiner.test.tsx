import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Stage4ScriptRefiner } from "./Stage4ScriptRefiner";

declare global {
  interface Window {
    gento?: {
      listOutputLibrary?: (root?: string) => Promise<any>;
      importStage4GeminiJson?: (outPath: string, geminiJson: string) => Promise<any>;
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

function setReactTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Stage4ScriptRefiner (batch paste)", () => {
  it("queues stage4 import + runStage(4) for selected runs", async () => {
    const calls: Array<{ recapPath: string; json: string }> = [];
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
                { name: "final", path: "./output/Manga A/final", recap_pages_path: null, refined_recap_path: null, storyboard_path: "./output/Manga A/final/storyboard.json" },
              ],
            },
            {
              name: "Manga B",
              path: "./output/Manga B",
              runs: [
                { name: "final_1", path: "./output/Manga B/final_1", recap_pages_path: null, refined_recap_path: null, storyboard_path: "./output/Manga B/final_1/storyboard.json" },
              ],
            },
          ],
        },
        error: null,
      })),
      importStage4GeminiJson: vi.fn(async (outPath: string, json: string) => {
        calls.push({ recapPath: outPath, json });
        return { ok: true, data: { gemini_path: outPath.replace("recap_pages_with_sentences.json", "gemini_narrator_pasted.json") }, error: null };
      }),
      runStage: vi.fn(async () => ({ ok: true, data: { events: [{ type: "complete", stage: 4, refined_recap_path: "x" }] }, error: null })),
      onStageEvent: () => () => {},
    };

    const { container, root } = renderIntoDocument(<Stage4ScriptRefiner />);
    await tick();
    await tick();

    const mangaBButton = Array.from(container.querySelectorAll('button[type="button"]')).find((btn) =>
      btn.textContent?.includes("Manga B"),
    ) as HTMLButtonElement | undefined;
    expect(mangaBButton).toBeTruthy();

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

    await selectRunCheckbox("final");
    act(() => mangaBButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    await selectRunCheckbox("final_1");
    await tick();

    const textareas = Array.from(container.querySelectorAll("textarea")) as HTMLTextAreaElement[];
    expect(textareas.length).toBe(2);

    act(() => {
      setReactTextareaValue(textareas[0], '{"mode":"page","pages":[{"page_idx":0,"recap":"","panels":[]}]}');
      setReactTextareaValue(textareas[1], '{"mode":"page","pages":[{"page_idx":0,"recap":"","panels":[]}]}');
    });
    await tick();

    const saveButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Run Stage 4"),
    ) as HTMLButtonElement | undefined;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });

    expect(window.gento.importStage4GeminiJson).toHaveBeenCalledTimes(2);
    expect(window.gento.runStage).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.recapPath)).toEqual([
      "./output/Manga A/final/recap_pages_with_sentences.json",
      "./output/Manga B/final_1/recap_pages_with_sentences.json",
    ]);

    act(() => root.unmount());
  });
});
