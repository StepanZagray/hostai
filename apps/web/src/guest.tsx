import { createRoot } from "react-dom/client";
import { GuestChat } from "./guest/guest-chat";
import { captureInvite } from "./guest/session";
import "@fontsource-variable/manrope";
import "@fontsource-variable/geist-mono";
import "./styles.css";

// Scrub the invite before mounting React or making any session/chat request.
captureInvite();
createRoot(document.getElementById("guest-root")!).render(<GuestChat />);
