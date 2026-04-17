import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SessionCard } from "./SessionCard";

const sessionBase = {
  mangaUrl: "https://example.com/manga",
  totalChapters: 20,
  selectedChapters: 5,
  progress: 42,
  isScraping: false,
  isRunningStage: false,
  lastOutputDir: "/tmp/gento-output",
  stageMessage: "Working on chapter list",
};

function renderIntoDocument(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

describe("SessionCard", () => {
  it("renders downloading status when a stage is running", () => {
    const { container } = renderIntoDocument(
      <SessionCard activeStage="Stage 1" session={{ ...sessionBase, isRunningStage: true }} />,
    );

    const content = container.textContent ?? "";
    expect(content).toContain("Downloading");
    expect(content).toContain("Stage 1");
    expect(content).toContain("5/20 selected");
    expect(content).toContain("42%");
    expect(content).toContain("Working on chapter list");
    expect(content).toContain("https://example.com/manga");
  });

  it("renders scraping status when scraping is active", () => {
    const { container } = renderIntoDocument(
      <SessionCard activeStage="Stage 0" session={{ ...sessionBase, isScraping: true, isRunningStage: false }} />,
    );

    expect(container.textContent).toContain("Scraping");
  });
});
