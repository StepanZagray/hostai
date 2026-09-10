import { Link } from "@tanstack/react-router";
import { css } from "../../styled-system/css";
import { usePublication } from "../directory/use-publication";
import { Button, PanelHeading, muted, panel, button } from "./ui";

export function DirectorySharing({ requestsEnabled = false }: { requestsEnabled?: boolean }) {
  const { status, error, loading, pending, refresh, start, stop } = usePublication();
  return (
    <section className={`${panel} ${css({ mb: "6" })}`} aria-label="Public directory listing">
      <PanelHeading
        title="Let clients find this host"
        description="Optional: publish this shared model in your configured directory."
      />
      <div className={css({ px: "5", pb: "5" })}>
        <p className={muted}>
          Publishing makes your host name, model, public address and stable host ID visible to
          everyone browsing that directory. Access keys remain private; clients still need your
          invitation{requestsEnabled ? " or your approval of their access request." : "."}
        </p>
        {!status ? (
          <p role="status" className={`${muted} ${css({ mt: "3" })}`}>
            {loading ? "Checking directory setup…" : "Directory status unavailable."}
          </p>
        ) : !status.configured ? (
          <p className={`${muted} ${css({ mt: "3" })}`}>
            No directory is configured. Set HOSTAI_DIRECTORY_URL on the gateway and restart it to
            use a directory you trust. Private invitations remain available.
          </p>
        ) : (
          <>
            <p className={`${muted} ${css({ mt: "3", overflowWrap: "anywhere" })}`}>
              Directory:{" "}
              <span className={css({ fontFamily: "mono", fontSize: "xs" })}>
                {status.registryUrl}
              </span>
            </p>
            <p role="status" className={css({ mt: "3", fontWeight: 700 })}>
              {
                {
                  off: "Not listed",
                  publishing: "Publishing listing…",
                  listed: "Listed in the directory",
                  withdrawing: "Removing listing…",
                  interrupted: "Listing updates interrupted",
                  failed: "Listing status needs attention",
                }[status.state]
              }
            </p>
            {status.identityId && (
              <p className={`${muted} ${css({ fontSize: "xs", overflowWrap: "anywhere" })}`}>
                Host ID: <code>{status.identityId}</code>. This identifies the same installation; it
                does not verify a person.
              </p>
            )}
            {status.state === "off" && !status.canPublish && (
              <p className={muted}>
                Start internet sharing and wait for its public connection check before publishing.
              </p>
            )}
            <div className={css({ display: "flex", gap: "3", flexWrap: "wrap", mt: "4" })}>
              <Button
                variant="primary"
                disabled={
                  pending ||
                  loading ||
                  !!error ||
                  !status.canPublish ||
                  status.enabled ||
                  status.state === "withdrawing"
                }
                onClick={() => void start()}
              >
                Publish listing
              </Button>
              <Button
                disabled={
                  pending ||
                  !(
                    error ||
                    status.enabled ||
                    ["listed", "withdrawing", "interrupted", "failed"].includes(status.state)
                  )
                }
                onClick={() => void stop()}
              >
                Remove listing
              </Button>
              <Link to="/hosts" className={button()}>
                Find a host
              </Link>
            </div>
            <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
              Removing the listing leaves your tunnel and existing keys usable. If removal cannot be
              confirmed, its last update expires within 90 seconds. Stop internet sharing to close
              public access; revoke a key to end that client’s permission.
            </p>
          </>
        )}
        {(error || status?.error) && (
          <p role="alert" className={css({ color: "warning", mt: "3" })}>
            {error || status?.error}
          </p>
        )}
        {(error || status?.error) && (
          <Button className={css({ mt: "3" })} disabled={loading} onClick={() => void refresh()}>
            Refresh directory status
          </Button>
        )}
      </div>
    </section>
  );
}
