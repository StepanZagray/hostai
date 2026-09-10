import { ArrowUpRight, Star } from "lucide-react";
import { css } from "../../styled-system/css";
import { Badge, Button, button, muted } from "../components/ui";
import { fresh, type DirectorySnapshot, type Listing } from "./registry";
import type { SavedHost } from "./saved-hosts";

export function DirectoryListing({
  listing,
  saved,
  snapshot,
  elapsed,
  error,
  currentElapsed,
  onToggle,
  onUpdate,
  savingDisabled,
  onCheckSaves,
}: {
  listing?: Listing;
  saved?: SavedHost;
  snapshot: DirectorySnapshot | null;
  elapsed: number;
  error: boolean;
  currentElapsed: () => number;
  onToggle: () => void;
  onUpdate: () => void;
  savingDisabled: boolean;
  onCheckSaves?: () => void;
}) {
  const item = listing ?? saved!;
  const expired = !listing || !snapshot || !fresh(listing, snapshot, elapsed);
  const seconds =
    listing && snapshot
      ? Math.max(0, Math.floor((snapshot.servedAt + elapsed - listing.updatedAt) / 1000))
      : 0;
  const updated =
    seconds < 60 ? `${seconds} seconds ago` : `${Math.floor(seconds / 60)} minutes ago`;
  const changed = saved && listing && saved.model !== listing.model;
  return (
    <li
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
          <bdi>{item.model}</bdi>
        </h2>
        <p className={css({ mt: "2", fontWeight: 700, overflowWrap: "anywhere" })}>
          <bdi>{item.hostLabel}</bdi>
        </p>
        <p className={muted}>
          {listing
            ? "Host-provided name · identity not verified"
            : "Remembered labels · current details unavailable"}
        </p>
        {changed && (
          <p
            className={css({ color: "warning", mt: "2", fontSize: "sm", overflowWrap: "anywhere" })}
          >
            Model changed. Saved model: <bdi>{saved.model}</bdi>. Review the current model above
            before opening.
          </p>
        )}
        {saved && listing && saved.hostLabel !== listing.hostLabel && (
          <p className={`${muted} ${css({ fontSize: "xs", overflowWrap: "anywhere" })}`}>
            Saved as <bdi>{saved.hostLabel}</bdi>
          </p>
        )}
        {listing && (
          <p
            className={`${muted} ${css({ mt: "3", fontFamily: "mono", fontSize: "xs", overflowWrap: "anywhere" })}`}
          >
            {new URL(listing.guestUrl).hostname}
          </p>
        )}
        <p className={`${muted} ${css({ fontSize: "xs", overflowWrap: "anywhere" })}`}>
          Host ID <code title={item.id}>{item.id.slice(0, 16)}</code> ·{" "}
          {listing
            ? "remains the same when its address changes"
            : "waiting for this installation to appear again"}
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
            : !snapshot
              ? "Checking directory"
              : !listing
                ? "Not currently listed"
                : expired
                  ? "Listing expired"
                  : `Updated ${updated}`}
        </Badge>
        <p className={`${muted} ${css({ fontSize: "xs" })}`}>
          {listing?.requestsAccepted === true
            ? "Requests reported open"
            : listing?.requestsAccepted === false
              ? "Requests reported closed · existing key needed"
              : "Request availability not reported"}
          <br />
          At last update · host approval required
        </p>
        {!expired && !error && listing && snapshot && changed ? (
          <Button
            variant="primary"
            disabled={savingDisabled}
            onClick={() => {
              if (fresh(listing, snapshot, currentElapsed())) onUpdate();
            }}
          >
            Use current model
          </Button>
        ) : !expired && !error && listing && snapshot ? (
          <a
            className={button({ variant: "primary" })}
            href={listing.guestUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open guest chat for ${listing.hostLabel}`}
            onClick={(event) => {
              if (!fresh(listing, snapshot, currentElapsed())) event.preventDefault();
            }}
          >
            Open guest chat <ArrowUpRight aria-hidden="true" />
          </a>
        ) : (
          <Button disabled>{error ? "Refresh before opening" : "Awaiting host update"}</Button>
        )}
        <Button
          disabled={savingDisabled}
          aria-pressed={!!saved}
          aria-label={`${saved ? "Remove saved host" : "Save host"} ${item.hostLabel}`}
          onClick={onToggle}
        >
          <Star aria-hidden="true" fill={saved ? "currentColor" : "none"} />
          {saved ? "Remove saved host" : "Save host"}
        </Button>
        {changed && onCheckSaves && (
          <Button onClick={onCheckSaves}>Check saves to review model</Button>
        )}
      </div>
    </li>
  );
}
