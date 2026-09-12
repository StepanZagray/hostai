import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { applyTheme, readTheme, themeOrder, type Theme } from "../lib/theme";
import { Button } from "./ui";

const icons = { system: Monitor, light: Sun, dark: Moon };
const names: Record<Theme, string> = {
  system: "Theme: match system",
  light: "Theme: light",
  dark: "Theme: dark",
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  // The document is already themed by the boot script; sync the control to it.
  useEffect(() => setTheme(readTheme()), []);
  const Icon = icons[theme];
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={names[theme]}
      title={names[theme]}
      onClick={() => {
        const next = themeOrder[(themeOrder.indexOf(theme) + 1) % themeOrder.length]!;
        setTheme(next);
        applyTheme(next);
      }}
    >
      <Icon strokeWidth={1.75} />
    </Button>
  );
}
