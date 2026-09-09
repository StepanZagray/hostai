import { useState } from "react";
import { ArrowUpRight, RefreshCw, Search } from "lucide-react";
import { css } from "../../styled-system/css";
import { Badge, Button, button, muted, panel } from "../components/ui";
import { fresh } from "./registry";
import { useDirectory } from "./use-directory";

export function DirectoryPage({ embedded = false }: { embedded?: boolean }) {
  const { snapshot, loading, error, elapsed, refresh, currentElapsed } = useDirectory(
    embedded ? "/api/directory/listings" : "/registry/v1/listings",
  );
  const Root = embedded ? "div" : "main";
  const [search, setSearch] = useState("");
  const [includeExpired, setIncludeExpired] = useState(false);
  const query = search.trim().toLowerCase();
  const listings = snapshot?.listings ?? [];
  const matching = listings.filter(
    (item) =>
      (includeExpired || fresh(item, snapshot!, elapsed)) &&
      `${item.model} ${item.hostLabel}`.toLowerCase().includes(query),
  );
  const hasExpired = snapshot && listings.some((item) => !fresh(item, snapshot, elapsed));
  return (
    <Root
      className={
        embedded
          ? undefined
          : css({
              maxW: "1100px",
              mx: "auto",
              px: { base: "4", md: "8" },
              py: { base: "6", md: "10" },
            })
      }
    >
      <p className={css({ fontWeight: 750, color: "accent", fontSize: "sm", mb: "3" })}>
        HostAI / Find a host
      </p>
      <header
        className={css({
          display: "flex",
          gap: "4",
          justifyContent: "space-between",
          alignItems: "start",
          flexWrap: "wrap",
          mb: "6",
        })}
      >
        <div>
          <h1
            className={css({
              fontSize: { base: "26px", md: "32px" },
              fontWeight: 750,
              letterSpacing: "-0.04em",
            })}
          >
            Find a model host
          </h1>
          <p className={`${muted} ${css({ mt: "2", maxW: "680px" })}`}>
            Browse hosts who chose to list their shared model. You can use their guest chat in your
            browser—no model download or local runtime needed.
          </p>
        </div>
        <Button onClick={() => void refresh()} disabled={loading}>
          <RefreshCw aria-hidden="true" /> {loading ? "Checking listings…" : "Refresh listings"}
        </Button>
      </header>

      <aside
        className={css({
          bg: "accentSoft",
          borderRadius: "8px",
          p: "4",
          mb: "6",
          fontSize: "sm",
          lineHeight: 1.8,
        })}
        aria-label="Before connecting"
      >
        <p className={css({ fontWeight: 700 })}>An invitation is still required.</p>
        <p>
          Get an access key from the host before chatting. This directory does not issue keys. Host
          names are self-reported; a recent update does not guarantee availability or verify who
          operates a host.
        </p>
        <p className={css({ mt: "2" })}>
          Opening a guest page contacts that host and its Cloudflare relay. Cloudflare terminates
          TLS and can see messages and access keys. Temporary addresses can change or go offline.
        </p>
      </aside>

      <section
        aria-label="Search hosts"
        className={css({
          display: "flex",
          gap: "4",
          flexWrap: "wrap",
          alignItems: "center",
          mb: "5",
        })}
      >
        <label
          className={css({
            display: "flex",
            alignItems: "center",
            gap: "3",
            bg: "surface",
            border: "1px solid token(colors.line)",
            borderRadius: "7px",
            px: "3",
            flex: "1 1 300px",
            color: "muted",
          })}
        >
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Search model or host"
            placeholder="Search model or host…"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={css({ minH: "44px", w: "full", minW: 0, bg: "transparent" })}
          />
        </label>
        {search && <Button onClick={() => setSearch("")}>Clear search</Button>}
        <label
          className={css({
            display: "flex",
            alignItems: "center",
            gap: "2",
            fontSize: "sm",
            minH: "44px",
          })}
        >
          <input
            type="checkbox"
            checked={includeExpired}
            onChange={(event) => setIncludeExpired(event.target.checked)}
          />
          Include expired listings
        </label>
      </section>

      {error && (
        <div
          role="alert"
          className={css({
            bg: "warningSoft",
            color: "warning",
            borderRadius: "8px",
            p: "4",
            mb: "4",
            lineHeight: 1.8,
          })}
        >
          The directory could not be checked.{" "}
          {snapshot
            ? "Previous listings are shown below; refresh successfully before opening a host."
            : "Refresh to try again. If you already have an invitation, open the link your host sent you."}
        </div>
      )}
      <p role="status" className={`${muted} ${css({ mb: "3" })}`}>
        {!snapshot && loading
          ? "Loading host listings…"
          : !snapshot
            ? "Host count unavailable"
            : `${matching.length} ${matching.length === 1 ? "listing" : "listings"}${query ? " matching your search" : ""}${error ? " from the previous check" : ""}.`}
      </p>
      <section className={panel} aria-label="Host listings" aria-busy={loading}>
        {!snapshot && loading ? (
          <div className={css({ p: "6" })}>
            <p className={css({ fontWeight: 700 })}>Checking this directory</p>
            <p className={muted}>Listings will appear after the directory responds.</p>
          </div>
        ) : !snapshot ? (
          <div className={css({ p: "6" })}>
            <h2 className={css({ fontSize: "lg", fontWeight: 700 })}>Host discovery unavailable</h2>
            <p className={muted}>The directory has not returned a valid list.</p>
          </div>
        ) : matching.length === 0 ? (
          <div className={css({ p: { base: "5", md: "8" } })}>
            <h2 className={css({ fontSize: "lg", fontWeight: 700 })}>
              {query
                ? "No matching hosts"
                : hasExpired && !includeExpired
                  ? "No recently updated hosts"
                  : "No hosts are listed yet"}
            </h2>
            <p className={muted}>
              {query
                ? "Try a model name or part of the host’s name."
                : hasExpired && !includeExpired
                  ? "Earlier listings have expired. Include expired listings to see them, or refresh later."
                  : "Hosts appear here after they explicitly publish a listing. An empty directory does not mean your connection is broken."}
            </p>
          </div>
        ) : (
          <ul>
            {matching.map((item) => {
              const expired = !fresh(item, snapshot, elapsed);
              const seconds = Math.max(
                0,
                Math.floor((snapshot.servedAt + elapsed - item.updatedAt) / 1000),
              );
              const updated =
                seconds < 60 ? `${seconds} seconds ago` : `${Math.floor(seconds / 60)} minutes ago`;
              const canOpen = !expired && !error;
              return (
                <li
                  key={item.id}
                  className={css({
                    p: { base: "5", md: "6" },
                    borderBottom: "1px solid token(colors.line)",
                    _last: { borderBottom: 0 },
                    display: "flex",
                    gap: "5",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                  })}
                >
                  <div className={css({ flex: "1 1 360px", minW: 0 })}>
                    <h2
                      className={css({
                        fontFamily: "mono",
                        fontSize: "lg",
                        fontWeight: 650,
                        overflowWrap: "anywhere",
                      })}
                    >
                      {item.model}
                    </h2>
                    <p className={css({ mt: "2", fontWeight: 700, overflowWrap: "anywhere" })}>
                      {item.hostLabel}
                    </p>
                    <p className={muted}>Host-provided name · identity not verified</p>
                    <p
                      className={`${muted} ${css({ mt: "3", fontFamily: "mono", fontSize: "xs", overflowWrap: "anywhere" })}`}
                    >
                      {new URL(item.guestUrl).hostname}
                    </p>
                    <p className={`${muted} ${css({ fontSize: "xs", overflowWrap: "anywhere" })}`}>
                      Host ID <code title={item.id}>{item.id.slice(0, 16)}</code> · remains the same
                      when its address changes
                    </p>
                  </div>
                  <div
                    className={css({
                      display: "flex",
                      flexDirection: "column",
                      alignItems: { base: "start", md: "end" },
                      gap: "3",
                    })}
                  >
                    <Badge tone={expired || error ? "warning" : "neutral"}>
                      {error
                        ? "Check unavailable"
                        : expired
                          ? "Listing expired"
                          : `Updated ${updated}`}
                    </Badge>
                    <p className={`${muted} ${css({ fontSize: "xs" })}`}>
                      Invitation required · one shared model
                    </p>
                    {canOpen ? (
                      <a
                        className={button({ variant: "primary" })}
                        href={item.guestUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open guest chat for ${item.hostLabel}`}
                        onClick={(event) => {
                          if (!fresh(item, snapshot, currentElapsed())) event.preventDefault();
                        }}
                      >
                        Open guest chat <ArrowUpRight aria-hidden="true" />
                      </a>
                    ) : (
                      <Button disabled>
                        {error ? "Refresh before opening" : "Awaiting host update"}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <footer className={`${muted} ${css({ mt: "5", fontSize: "xs" })}`}>
        Only this directory’s listings are shown. Updates expire after 90 seconds; expired listings
        remain for up to 15 minutes. Your search stays in this page. Browsing does not contact the
        listed hosts.
      </footer>
    </Root>
  );
}
