import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { useTheme } from "./useTheme";

function TestThemeComponent() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme}>
      {theme}
    </button>
  );
}

function renderElement(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useTheme hook", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.setAttribute("data-theme", "");
  });

  it("reads saved theme from localStorage and applies it to document", async () => {
    window.localStorage.setItem("gento-theme", "dark");
    const { container } = renderElement(<TestThemeComponent />);

    await tick();

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("toggles theme and updates localStorage", async () => {
    window.localStorage.setItem("gento-theme", "light");
    const { container } = renderElement(<TestThemeComponent />);

    await tick();

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("light");

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await tick();

    expect(button?.textContent).toBe("dark");
    expect(window.localStorage.getItem("gento-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
