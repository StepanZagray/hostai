import { useRef } from "react";
import { css } from "../../styled-system/css";
import { Button, muted } from "./ui";

export function KeyCleanup({
  removable,
  total,
  ready,
  pending,
  removing,
  message,
  onRemove,
}: {
  removable: number | undefined;
  total: number;
  ready: boolean;
  pending: boolean;
  removing: boolean;
  message: string;
  onRemove: () => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={group}
      tabIndex={-1}
      className={css({ mb: "5" })}
      role="group"
      aria-label="Key storage cleanup"
      aria-busy={removing}
      aria-describedby="key-cleanup-availability"
    >
      <h3 className={css({ fontWeight: 650 })}>Free key storage</h3>
      <p className={muted}>
        Remove saved records for expired or revoked keys to free space. Keys that still have
        permission are kept, including paused ones. Removed records cannot be recovered. The gateway
        checks expiry again when you remove records.
      </p>
      <p id="key-cleanup-availability" className={`${muted} ${css({ mt: "2" })}`}>
        {!ready
          ? "Refresh access to check which keys can be removed."
          : removable === undefined
            ? "This gateway does not support key cleanup. Update and restart the gateway to enable it."
            : removable > 0
              ? `${removable} expired or revoked ${removable === 1 ? "key can" : "keys can"} be removed, according to the gateway.`
              : total >= 100
                ? "No keys can be removed yet. Revoke an unused key first."
                : "No expired or revoked keys to remove."}
      </p>
      <Button
        type="button"
        disabled={!ready || pending || !removable}
        aria-describedby="key-cleanup-availability"
        onClick={() => {
          if (!ready || pending || !removable) return;
          onRemove();
          group.current?.focus({ preventScroll: true });
        }}
        className={css({
          mt: "3",
          minH: "44px",
          maxW: "full",
          whiteSpace: "normal",
          textAlign: "left",
        })}
      >
        {removing ? "Removing ended keys…" : "Remove expired and revoked keys"}
      </Button>
      <p role="status" className={`${muted} ${css({ mt: "2" })}`}>
        {message}
      </p>
    </div>
  );
}
