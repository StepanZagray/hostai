import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { chatUnavailableReason } from "../lib/model-admission";
import type { ModelDownload } from "../lib/model-downloads";
import { Badge, Button, button, caption } from "./ui";

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
    <div className={downloads.length ? css({ mt: "4", minW: 0 }) : undefined}>
      <p
        id={noticeId}
        role="status"
        aria-atomic="true"
        className={css({ color: "amber", fontSize: "xs", lineHeight: 1.55 })}
      >
        {downloads.length > 0 &&
          `${downloads.length} previously running ${downloads.length === 1 ? "download is" : "downloads are"} no longer reported by the gateway. It may have restarted or removed the records. This does not confirm whether they finished or whether Ollama is still downloading.`}
      </p>
      {downloads.length > 0 && (
        <ul className={css({ mt: "3", minW: 0 })}>
          {downloads.map((job) => {
            const installed = models.find((model) => model.name === job.model);
            const available =
              !!status?.ollamaConnected && installed && chatUnavailableReason(installed) === null;
            const canTry = available && !dismissDisabled;
            return (
              <li
                key={job.id}
                data-download-row={job.id}
                className={css({
                  py: "3",
                  minW: 0,
                  borderTop: "1px solid token(colors.lineSoft)",
                  _last: { pb: 0 },
                })}
              >
                <div
                  className={css({
                    display: "flex",
                    gap: "2.5",
                    flexWrap: "wrap",
                    alignItems: "center",
                    minW: 0,
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
                      fontWeight: 600,
                      lineHeight: 1.4,
                      overflowWrap: "anywhere",
                      minW: 0,
                    })}
                  >
                    {job.model}
                  </h3>
                  <Badge tone="warning">Status unknown</Badge>
                </div>
                <p className={`${caption} ${css({ mt: "1" })}`}>
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
                <div
                  className={css({
                    display: "flex",
                    alignItems: "center",
                    gap: "2",
                    flexWrap: "wrap",
                    mt: "2.5",
                  })}
                >
                  {canTry && (
                    <Link
                      to="/playground"
                      search={{ model: job.model }}
                      aria-label={`Try available model ${job.model}`}
                      className={button({ variant: "primary", size: "sm" })}
                    >
                      Try available model
                    </Link>
                  )}
                  <Button
                    size="sm"
                    aria-label={`Check model library for ${job.model}`}
                    disabled={refreshing}
                    onClick={() => void refresh()}
                  >
                    Check model library
                  </Button>
                  <Button
                    size="sm"
                    aria-label={`Download again ${job.model}`}
                    aria-describedby={noticeId}
                    disabled={restartDisabled}
                    onClick={() => onRestart(job.model)}
                  >
                    Download again
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Dismiss notice for ${job.model}`}
                    disabled={dismissDisabled}
                    onClick={() => onDismiss(job.id)}
                  >
                    Dismiss notice
                  </Button>
                </div>
                <p className={`${caption} ${css({ mt: "2" })}`}>
                  Download again starts a new request; cached layers may be reused. Dismissing only
                  clears this notice.
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
