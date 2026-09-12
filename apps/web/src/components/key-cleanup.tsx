import { useRef } from "react";
import { css } from "../../styled-system/css";
import { Button, caption, muted } from "./ui";

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
      className={css({ pb: "4", minW: 0 })}
      role="group"
      aria-label="Key storage cleanup"
      aria-busy={removing}
      aria-describedby="key-cleanup-availability"
    >
      <h3 className={css({ fontSize: "sm", fontWeight: 600 })}>Free key storage</h3>
      <p className={`${caption} ${css({ mt: "1" })}`}>
        Removes stored records for keys that already expired or were revoked, rechecking expiry as
        it goes. Keys that still grant access — including paused ones — are kept. Removal is
        permanent.
      </p>
      <p
        id="key-cleanup-availability"
        className={`${muted} ${css({ mt: "2", fontVariantNumeric: "tabular-nums" })}`}
      >
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
      <div
        className={css({
          display: "flex",
          alignItems: "center",
          gap: "3",
          flexWrap: "wrap",
          mt: "2.5",
          minW: 0,
        })}
      >
        <Button
          type="button"
          disabled={!ready || pending || !removable}
          aria-describedby="key-cleanup-availability"
          onClick={() => {
            if (!ready || pending || !removable) return;
            onRemove();
            group.current?.focus({ preventScroll: true });
          }}
          className={css({ textAlign: "left" })}
        >
          {removing ? "Removing ended keys…" : "Remove expired and revoked keys"}
        </Button>
        <p role="status" className={`${caption} ${css({ minW: 0, flex: "1 1 16rem" })}`}>
          {message}
        </p>
      </div>
    </div>
  );
}
