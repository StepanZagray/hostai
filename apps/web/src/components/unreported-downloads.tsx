import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { chatUnavailableReason } from "../lib/model-admission";
import type { ModelDownload } from "../lib/model-downloads";
import { Badge, Button, button, muted } from "./ui";

export function UnreportedDownloads({
  downloads,
  restartDisabled,
  dismissDisabled,
  onRestart,
  onDismiss,
}: {
  downloads: ModelDownload[];
  restartDisabled: boolean;
  dismissDisabled: boolean;
  onRestart: (model: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { models, status, errors, refreshing, refresh } = useHost();
  const noticeId = useId();
  return (
    <div className={downloads.length ? css({ mt: "5" }) : undefined}>
      <p
        id={noticeId}
        role="status"
        aria-atomic="true"
        className={css({ color: "warning", fontSize: "sm" })}
      >
        {downloads.length > 0 &&
          `${downloads.length} previously running ${downloads.length === 1 ? "download is" : "downloads are"} no longer reported by the gateway. It may have restarted or removed the records. This does not confirm whether they finished or whether Ollama is still downloading.`}
      </p>
      {downloads.length > 0 && (
        <ul className={css({ display: "grid", gap: "4", mt: "3" })}>
          {downloads.map((job) => {
            const installed = models.find((model) => model.name === job.model);
            const available =
              !!status?.ollamaConnected && installed && chatUnavailableReason(installed) === null;
            const canTry = available && !dismissDisabled;
            return (
              <li
                key={job.id}
                data-download-row={job.id}
                className={css({ borderTop: "1px solid token(colors.line)", pt: "4" })}
              >
                <div
                  className={css({
                    display: "flex",
                    gap: "3",
                    flexWrap: "wrap",
                    alignItems: "center",
                  })}
                >
                  <h3
                    tabIndex={-1}
                    data-unreported-download={job.id}
                    aria-label={`Download status unknown for ${job.model}`}
                    aria-describedby={noticeId}
                    className={css({
                      fontFamily: "mono",
                      fontSize: "sm",
                      fontWeight: 650,
                      overflowWrap: "anywhere",
                    })}
                  >
                    {job.model}
                  </h3>
                  <Badge tone="warning">Status unknown</Badge>
                </div>
                <p className={`${muted} ${css({ mt: "2", fontSize: "xs" })}`}>
                  {available
                    ? "This model is currently listed in the library. You can try it without downloading again."
                    : errors.models
                      ? "The model library could not be checked. Check it again before downloading more files."
                      : !status?.ollamaConnected
                        ? "Check the Ollama connection and model library before starting again."
                        : installed
                          ? chatUnavailableReason(installed)
                          : "The latest library check did not find this exact tag. Check again before downloading more files."}
                </p>
                <div className={css({ display: "flex", gap: "3", flexWrap: "wrap", mt: "3" })}>
                  {canTry && (
                    <Link
                      to="/playground"
                      search={{ model: job.model }}
                      aria-label={`Try available model ${job.model}`}
                      className={button({ variant: "primary" })}
                    >
                      Try available model
                    </Link>
                  )}
                  <Button
                    aria-label={`Check model library for ${job.model}`}
                    disabled={refreshing}
                    onClick={() => void refresh()}
                  >
                    Check model library
                  </Button>
                  <Button
                    aria-label={`Download again ${job.model}`}
                    aria-describedby={noticeId}
                    disabled={restartDisabled}
                    onClick={() => onRestart(job.model)}
                  >
                    Download again
                  </Button>
                  <Button
                    aria-label={`Dismiss notice for ${job.model}`}
                    disabled={dismissDisabled}
                    onClick={() => onDismiss(job.id)}
                  >
                    Dismiss notice
                  </Button>
                </div>
                <p className={`${muted} ${css({ mt: "2", fontSize: "xs" })}`}>
                  Download again starts a new request. Cached layers may be reused; more data may be
                  transferred. Dismissing this notice does not cancel a download or remove model
                  files.
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
