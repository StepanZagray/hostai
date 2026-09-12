export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "hostai-theme";
export const themeOrder: Theme[] = ["system", "light", "dark"];

/**
 * Runs before first paint in the document head so an explicit choice never
 * flashes the other palette. Without a stored choice the CSS falls back to
 * `prefers-color-scheme`, so there is nothing to set.
 */
export const themeBootScript = `try{var t=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "dark" || stored === "light" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // A blocked storage API still leaves the current document themed.
  }
}

export type EffectiveTheme = "light" | "dark";

/** The palette actually shown: an explicit choice, else the operating system's. */
export function resolveEffectiveTheme(): EffectiveTheme {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark" || explicit === "light") return explicit;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Calls back whenever the effective palette changes, whether through the theme
 * toggle (`data-theme` on <html>) or the operating system. Returns a disposer.
 */
export function observeEffectiveTheme(onChange: (theme: EffectiveTheme) => void): () => void {
  let current = resolveEffectiveTheme();
  const check = () => {
    const next = resolveEffectiveTheme();
    if (next === current) return;
    current = next;
    onChange(next);
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media =
    typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  media?.addEventListener("change", check);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", check);
  };
}
