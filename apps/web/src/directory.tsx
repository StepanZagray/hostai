import { createRoot } from "react-dom/client";
import { DirectoryPage } from "./directory/directory-page";
import "@fontsource-variable/manrope";
import "@fontsource-variable/geist-mono";
import "./styles.css";

createRoot(document.getElementById("directory-root")!).render(
  <DirectoryPage registryOrigin={window.location.origin} />,
);
