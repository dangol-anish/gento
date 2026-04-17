import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import HomeClient from "./HomeClient";

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

describe("HomeClient page", () => {
  it("toggles between pipeline and settings views", async () => {
    const { container } = renderIntoDocument(<HomeClient />);

    expect(container.textContent).toContain("Pipeline Control");

    const navigationButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Navigation"),
    );
    expect(navigationButton).toBeTruthy();

    act(() => {
      navigationButton?.click();
    });

    await tick();

    const settingsButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Settings",
    );
    expect(settingsButton).toBeTruthy();

    act(() => {
      settingsButton?.click();
    });

    await tick();
    expect(container.textContent).toContain("Application appearance and behavior controls.");

    const backButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Back to Pipeline"),
    );
    expect(backButton).toBeTruthy();

    act(() => {
      backButton?.click();
    });

    await tick();
    expect(container.textContent).toContain("Pipeline Control");
  });
});
