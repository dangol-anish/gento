import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Progress } from "./progress";

function renderIntoDocument(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

describe("Progress component", () => {
  it("clamps value above 100 to 100", () => {
    const { container } = renderIntoDocument(<Progress value={120} />);
    const progressbar = container.querySelector("[role=progressbar]");
    const label = container.querySelector(".progress-label");

    expect(progressbar?.getAttribute("aria-valuenow")).toBe("100");
    expect(label?.textContent).toBe("100%");
  });

  it("clamps negative value to 0", () => {
    const { container } = renderIntoDocument(<Progress value={-5} />);
    const progressbar = container.querySelector("[role=progressbar]");
    const label = container.querySelector(".progress-label");

    expect(progressbar?.getAttribute("aria-valuenow")).toBe("0");
    expect(label?.textContent).toBe("0%");
  });
});
