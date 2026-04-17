import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

function renderIntoDocument(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

describe("SettingsView", () => {
  it("renders theme toggle and back button", () => {
    const toggleTheme = vi.fn();
    const onBack = vi.fn();

    const { container } = renderIntoDocument(
      <SettingsView theme="dark" toggleTheme={toggleTheme} onBack={onBack} />,
    );

    expect(container.textContent).toContain("Settings");
    expect(container.textContent).toContain("Light Mode");

    const toggleButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Light Mode"),
    );
    const backButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Back to Pipeline"),
    );

    act(() => {
      toggleButton?.click();
      backButton?.click();
    });

    expect(toggleTheme).toHaveBeenCalled();
    expect(onBack).toHaveBeenCalled();
  });
});
