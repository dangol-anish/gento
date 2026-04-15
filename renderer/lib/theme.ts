export type ThemeMode = "light" | "dark";

export function applyThemeToDocument(theme: ThemeMode) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.setAttribute("data-theme", theme);
}

