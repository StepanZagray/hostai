import { useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { css } from "../../styled-system/css";
import { Button, muted, panel } from "../components/ui";
import { fresh } from "./registry";
import { useDirectory } from "./use-directory";
import { useSavedHosts } from "./use-saved-hosts";
import { DirectoryListing } from "./directory-listing";

export function DirectoryPage({
  embedded = false,
  registryOrigin,
}: {
  embedded?: boolean;
  registryOrigin: string;
}) {
  const saves = useSavedHosts(registryOrigin);
  const [savedOnly, setSavedOnly] = useState(false);
  const { snapshot, loading, error, sourceMismatch, elapsed, refresh, currentElapsed } =
    useDirectory(embedded ? "/api/directory/listings" : "/registry/v1/listings", registryOrigin);
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
  const rows = savedOnly
    ? saves.entries
        .map((saved) => ({ saved, listing: listings.find((item) => item.id === saved.id) }))
        .filter(({ saved, listing }) =>
          `${saved.model} ${saved.hostLabel} ${listing?.model ?? ""} ${listing?.hostLabel ?? ""}`
            .toLowerCase()
            .includes(query),
        )
    : matching.map((listing) => ({
        listing,
        saved: saves.entries.find((item) => item.id === listing.id),
      }));
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
        <p className={css({ fontWeight: 700 })}>The host must approve access.</p>
        <p>
          Open the guest page to request access if the host allows it, or use an invitation key.
          This directory does not issue keys. Host names are self-reported; a recent update does not
          guarantee availability or verify who operates a host.
        </p>
        <p className={css({ mt: "2" })}>
          Opening a guest page contacts that host and its Cloudflare relay. Cloudflare terminates
          TLS and can see messages and access keys. Temporary addresses can change or go offline.
        </p>
      </aside>

      <div
        role="group"
        aria-label="Host view"
        className={css({ display: "flex", gap: "3", flexWrap: "wrap", mb: "3" })}
      >
        <Button
          variant={!savedOnly ? "primary" : "secondary"}
          aria-pressed={!savedOnly}
          onClick={() => setSavedOnly(false)}
        >
          All listings
        </Button>
        <Button
          variant={savedOnly ? "primary" : "secondary"}
          aria-pressed={savedOnly}
          onClick={() => setSavedOnly(true)}
        >
          Saved hosts{!saves.loading && !saves.blocked ? ` (${saves.entries.length})` : ""}
        </Button>
      </div>
      <p className={`${muted} ${css({ fontSize: "xs", mb: "4", overflowWrap: "anywhere" })}`}>
        Saved hosts belong to {registryOrigin}. Only installation IDs and remembered host and model
        names are stored in this browser. Keys and guest addresses are not saved. Opening always
        uses a current directory listing; an address can change. Saves do not sync between the
        workspace and directory website.
      </p>
      {saves.error && (
        <div role="alert" className={css({ mb: "4" })}>
          <p className={muted}>{saves.error}</p>
          <Button onClick={saves.refresh}>Check saved hosts</Button>
        </div>
      )}
      <div role="status" className={`${muted} ${css({ fontSize: "xs", mb: "3" })}`}>
        {saves.notice}
        {saves.removed && (
          <div className={css({ overflowWrap: "anywhere" })}>
            Last removal: <bdi>{saves.removed.hostLabel}</bdi> · <bdi>{saves.removed.model}</bdi>.{" "}
            <Button disabled={saves.blocked} onClick={saves.undo}>
              Undo remove
            </Button>
          </div>
        )}
      </div>
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
        {!savedOnly && (
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
        )}
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
          {sourceMismatch && (
            <p className={css({ mt: "2" })}>
              The gateway did not confirm this directory’s source. Reload to check directory setup;
              if this continues, update and restart the gateway.
            </p>
          )}
        </div>
      )}
      <p role="status" className={`${muted} ${css({ mb: "3" })}`}>
        {savedOnly
          ? saves.loading
            ? "Loading saved hosts…"
            : saves.blocked
              ? "Saved host count unavailable"
              : `${rows.length} saved ${rows.length === 1 ? "host" : "hosts"}${query ? " matching your search" : ""}.`
          : !snapshot && loading
            ? "Loading host listings…"
            : !snapshot
              ? "Host count unavailable"
              : `${rows.length} ${rows.length === 1 ? "listing" : "listings"}${query ? " matching your search" : ""}${error ? " from the previous check" : ""}.`}
      </p>
      <section className={panel} aria-label="Host listings" aria-busy={loading}>
        {savedOnly && !rows.length && !saves.loading ? (
          <div className={css({ p: "6" })}>
            <h2 className={css({ fontSize: "lg", fontWeight: 700 })}>
              {saves.error
                ? "Saved hosts unavailable"
                : query
                  ? "No matching saved hosts"
                  : "No saved hosts yet"}
            </h2>
            <p className={muted}>
              {saves.error
                ? "Use Check saved hosts above to retry browser storage. Your saved records have not been reset."
                : query
                  ? "Search remembered or current model and host names."
                  : "Use Save host on a listing to find that installation again. Saving does not grant access or verify its identity."}
            </p>
          </div>
        ) : !savedOnly && !snapshot && loading ? (
          <div className={css({ p: "6" })}>
            <p className={css({ fontWeight: 700 })}>Checking this directory</p>
            <p className={muted}>Listings will appear after the directory responds.</p>
          </div>
        ) : !savedOnly && !snapshot ? (
          <div className={css({ p: "6" })}>
            <h2 className={css({ fontSize: "lg", fontWeight: 700 })}>Host discovery unavailable</h2>
            <p className={muted}>The directory has not returned a valid list.</p>
          </div>
        ) : !savedOnly && matching.length === 0 ? (
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
            {rows.map(({ listing, saved }) => (
              <DirectoryListing
                key={(listing ?? saved!).id}
                listing={listing}
                saved={saved}
                snapshot={snapshot}
                elapsed={elapsed}
                error={error}
                currentElapsed={currentElapsed}
                savingDisabled={saves.loading || saves.blocked}
                onCheckSaves={saves.blocked ? saves.refresh : undefined}
                onToggle={() => saves.toggle(listing ?? saved!)}
                onUpdate={() => {
                  if (listing) saves.update(listing);
                }}
              />
            ))}
          </ul>
        )}
      </section>
      <footer className={`${muted} ${css({ mt: "5", fontSize: "xs" })}`}>
        Listings come only from this directory. Updates expire after 90 seconds; expired listings
        remain for up to 15 minutes. Your search stays in this page. Browsing does not contact the
        listed hosts.
      </footer>
    </Root>
  );
}
