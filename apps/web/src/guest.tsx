import { createRoot } from "react-dom/client";
import { GuestChat } from "./guest/guest-chat";
import { captureInvite } from "./guest/session";
import { readTheme } from "./lib/theme";
import "@fontsource-variable/instrument-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

// Scrub the invite before mounting React or making any session/chat request.
captureInvite();
// A stored preference only reads here; nothing is written until a guest asks for it.
const theme = readTheme();
if (theme !== "system") document.documentElement.setAttribute("data-theme", theme);
createRoot(document.getElementById("guest-root")!).render(<GuestChat />);
