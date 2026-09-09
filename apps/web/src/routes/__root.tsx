import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { Shell } from "../components/shell";
import { HostProvider } from "../lib/host-context";
import "@fontsource-variable/manrope";
import "@fontsource-variable/geist-mono";
import "../styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "HostAI · Your local inference workspace" },
      {
        name: "description",
        content:
          "A local workspace for your AI models. Inspect your host, explore models, and run inference.",
      },
    ],
  }),
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <HostProvider>
          <Shell />
        </HostProvider>
        <Scripts />
      </body>
    </html>
  ),
  notFoundComponent: () => (
    <p>
      Page not found. <a href="/">Return to overview</a>
    </p>
  ),
});
