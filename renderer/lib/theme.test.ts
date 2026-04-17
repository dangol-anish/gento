import { beforeEach, describe, expect, it } from "vitest";
import { applyThemeToDocument } from "./theme";

describe("applyThemeToDocument", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.setAttribute("data-theme", "");
  });

  it("applies dark theme classes and attributes", () => {
    applyThemeToDocument("dark");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("removes dark theme class for light theme and sets attribute", () => {
    document.documentElement.classList.add("dark");

    applyThemeToDocument("light");

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
