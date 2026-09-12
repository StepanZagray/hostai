import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { css } from "../../styled-system/css";
import { Shell } from "../components/shell";
import { OwnerConversationsProvider } from "../lib/owner-conversations-context";
import { SharingDraftProvider } from "../lib/sharing-draft-context";
import { ModelDownloadProvider } from "../lib/model-download-context";
import { HostProvider } from "../lib/host-context";
import { themeBootScript } from "../lib/theme";
import "@fontsource-variable/instrument-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { title: "HostAI · Local inference workspace" },
      {
        name: "description",
        content:
          "Run your own models locally: connect a runtime, download models, chat, and share access with guests.",
      },
    ],
  }),
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <HostProvider>
          <OwnerConversationsProvider>
            <SharingDraftProvider>
              <ModelDownloadProvider>
                <Shell />
              </ModelDownloadProvider>
            </SharingDraftProvider>
          </OwnerConversationsProvider>
        </HostProvider>
        <Scripts />
      </body>
    </html>
  ),
  notFoundComponent: () => (
    <div className={css({ p: "8", display: "grid", gap: "2", maxW: "48ch" })}>
      <h1 className={css({ textStyle: "display" })}>Page not found</h1>
      <p className={css({ color: "muted" })}>Nothing is served at this address.</p>
      <p>
        <a href="/" className={css({ textDecoration: "underline", textUnderlineOffset: "3px" })}>
          Back to overview
        </a>
      </p>
    </div>
  ),
});
