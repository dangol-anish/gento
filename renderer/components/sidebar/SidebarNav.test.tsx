import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SidebarNav } from "./SidebarNav";

function renderIntoDocument(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

describe("SidebarNav", () => {
  it("calls callbacks when stage buttons and settings are clicked", () => {
    const setActiveStage = vi.fn();
    const onOpenSettings = vi.fn();
    const onCheckPrerequisites = vi.fn();
    const setSidebarOpen = vi.fn();

    const { container } = renderIntoDocument(
      <SidebarNav
        stages={[
          { id: 0, label: "Download" },
          { id: 1, label: "Extract" },
        ]}
        activeStage={0}
        setActiveStage={setActiveStage}
        onOpenSettings={onOpenSettings}
        onCheckPrerequisites={onCheckPrerequisites}
        sidebarOpen={true}
        setSidebarOpen={setSidebarOpen}
      />,
    );

    const extractButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Extract"),
    );
    expect(extractButton).toBeTruthy();

    act(() => {
      extractButton?.click();
    });

    expect(setActiveStage).toHaveBeenCalledWith(1);
    expect(setSidebarOpen).toHaveBeenCalledWith(false);

    const settingsButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Settings"),
    );
    expect(settingsButton).toBeTruthy();

    act(() => {
      settingsButton?.click();
    });

    expect(onOpenSettings).toHaveBeenCalled();
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });
});
