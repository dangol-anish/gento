import { useEffect, useState } from "react";

import { applyThemeToDocument, type ThemeMode } from "@/lib/theme";

const STORAGE_KEY = "gento-theme";

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>("light");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    const nextTheme: ThemeMode = saved === "dark" ? "dark" : "light";
    setTheme(nextTheme);
    applyThemeToDocument(nextTheme);
  }, []);

  const toggleTheme = () => {
    setTheme((current) => {
      const next: ThemeMode = current === "dark" ? "light" : "dark";
      applyThemeToDocument(next);
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  };

  return { theme, toggleTheme };
}

