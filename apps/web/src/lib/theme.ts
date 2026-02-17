import type { UserTheme } from "./api";

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

const setThemeClass = (isDark: boolean): void => {
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
};

export const syncDocumentTheme = (theme: UserTheme): (() => void) => {
  if (theme === "dark") {
    setThemeClass(true);
    return () => undefined;
  }

  if (theme === "light") {
    setThemeClass(false);
    return () => undefined;
  }

  const mediaQuery = window.matchMedia(SYSTEM_DARK_QUERY);
  const apply = (): void => setThemeClass(mediaQuery.matches);
  apply();

  const onChange = (): void => apply();
  mediaQuery.addEventListener("change", onChange);

  return () => {
    mediaQuery.removeEventListener("change", onChange);
  };
};

