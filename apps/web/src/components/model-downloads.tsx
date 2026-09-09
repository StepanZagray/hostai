import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { useModelDownloads } from "../lib/use-model-downloads";
import { downloadModelError } from "../lib/model-downloads";
import { chatUnavailableReason } from "../lib/model-admission";
import { Badge, Button, ExternalLink, PanelHeading, button, muted, panel } from "./ui";

const sizes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const bytes = (value: number) =>
  value >= 1e9 ? `${sizes.format(value / 1e9)} GB` : `${sizes.format(value / 1e6)} MB`;

export function ModelDownloads() {
  const { status, models, errors, refresh } = useHost();
  const jobs = useModelDownloads(refresh);
  const [model, setModel] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const selected = jobs.uncertain?.model ?? model.trim();
  const validation = downloadModelError(selected);
  const active = jobs.downloads.find((job) => job.state === "running");
  const canStart =
    !!status?.ollamaConnected && !jobs.loading && !jobs.statusError && !jobs.pending && !active;
  return (
    <section className={`${panel} ${css({ mb: "6" })}`} aria-label="Model downloads">
      <PanelHeading
        title="Download a model"
        description="Bring a model from the Ollama library onto this host."
      />
      <div className={css({ px: "5", pb: "5" })}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (canStart && !validation) void jobs.start(selected);
          }}
        >
          <label
            htmlFor="download-model"
            className={css({ display: "block", fontSize: "xs", fontWeight: 700, mb: "2" })}
          >
            Model and tag
          </label>
          <div
            className={css({ display: "flex", gap: "3", flexWrap: "wrap", alignItems: "start" })}
          >
            <input
              id="download-model"
              value={jobs.uncertain?.model ?? model}
              onChange={(event) => setModel(event.target.value)}
              disabled={jobs.pending || !!jobs.uncertain}
              aria-describedby={
                submitted && validation ? "download-help download-error" : "download-help"
              }
              aria-invalid={submitted && !!validation}
              placeholder="qwen3:0.6b"
              autoComplete="off"
              spellCheck={false}
              className={css({
                minW: 0,
                flex: "1 1 260px",
                minH: "44px",
                border: "1px solid token(colors.line)",
                bg: "canvas",
                borderRadius: "7px",
                px: "3",
                fontFamily: "mono",
                fontSize: "sm",
              })}
            />
            <Button variant="primary" type="submit" disabled={!canStart}>
              <Download size={16} />
              {jobs.pending
                ? "Working…"
                : jobs.uncertain
                  ? "Retry start request"
                  : "Download model"}
            </Button>
          </div>
          <p id="download-help" className={`${muted} ${css({ fontSize: "xs", mt: "3" })}`}>
            Choose an explicit tag, such as qwen3:0.6b. Downloading uses this host’s disk and
            internet connection. Check the model’s requirements first; HostAI does not estimate
            available memory or download size in advance.
          </p>
          <ExternalLink href="https://ollama.com/library">
            Browse model names and requirements
          </ExternalLink>
          {submitted && validation && (
            <p
              id="download-error"
              role="alert"
              className={css({ color: "danger", fontSize: "xs", mt: "2" })}
            >
              {validation}
            </p>
          )}
        </form>
        {!status?.ollamaConnected && (
          <p className={`${muted} ${css({ mt: "3" })}`}>
            Connect Ollama on this host before downloading.{" "}
            <Link
              to="/connection"
              className={css({ color: "accent", textDecoration: "underline" })}
            >
              Open setup
            </Link>
          </p>
        )}
        {jobs.loading && (
          <p role="status" className={`${muted} ${css({ mt: "3" })}`}>
            Checking downloads…
          </p>
        )}
        {jobs.statusError && (
          <div className={css({ mt: "3" })}>
            <p role="alert" className={css({ color: "warning", fontSize: "sm" })}>
              {jobs.statusError} Saved progress may be out of date.
            </p>
            <Button disabled={jobs.refreshing} onClick={() => void jobs.refresh()}>
              <RefreshCw size={15} />
              {jobs.refreshing ? "Checking download status…" : "Check download status"}
            </Button>
          </div>
        )}
        {jobs.actionError && (
          <p role="alert" className={css({ color: "danger", mt: "3", fontSize: "sm" })}>
            {jobs.actionError}
          </p>
        )}
        {jobs.uncertain && (
          <div className={css({ mt: "3" })}>
            {!jobs.statusError && (
              <Button disabled={jobs.refreshing} onClick={() => void jobs.refresh()}>
                <RefreshCw size={15} />
                {jobs.refreshing ? "Checking download status…" : "Check download status"}
              </Button>
            )}
            <Button disabled={jobs.pending} onClick={jobs.dismissUncertain}>
              Use a different model
            </Button>
            <p className={`${muted} ${css({ fontSize: "xs", mt: "2" })}`}>
              Changing the entry does not cancel a download the gateway may have accepted.
            </p>
          </div>
        )}
        {active && (
          <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
            One download at a time. It continues when you leave this page; keep the gateway running.
          </p>
        )}
        {jobs.downloads.length > 0 && (
          <ul className={css({ mt: "5", display: "grid", gap: "4" })}>
            {jobs.downloads.map((job) => {
              const installed = models.find((item) => item.name === job.model);
              const chatReady =
                !!status?.ollamaConnected && installed && chatUnavailableReason(installed) === null;
              const progress = job.state === "running" && job.phase === "downloading" && job.digest;
              const measured =
                progress &&
                job.totalBytes !== null &&
                job.totalBytes > 0 &&
                job.completedBytes !== null;
              return (
                <li
                  key={job.id}
                  className={css({ borderTop: "1px solid token(colors.line)", pt: "4" })}
                >
                  <div
                    className={css({
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "3",
                      flexWrap: "wrap",
                    })}
                  >
                    <h3
                      className={css({
                        fontFamily: "mono",
                        fontSize: "sm",
                        fontWeight: 650,
                        overflowWrap: "anywhere",
                      })}
                    >
                      {job.model}
                    </h3>
                    <Badge
                      tone={
                        job.state === "completed"
                          ? "good"
                          : job.state === "failed"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {job.state === "completed"
                        ? "Downloaded"
                        : job.state === "failed"
                          ? "Download failed"
                          : job.state === "cancelled"
                            ? "Cancelled"
                            : "In progress"}
                    </Badge>
                  </div>
                  <p
                    role="status"
                    aria-atomic="true"
                    className={`${muted} ${css({ mt: "2", fontSize: "xs" })}`}
                  >
                    {job.error || job.message}
                  </p>
                  {job.state === "running" && (
                    <div className={css({ mt: "3" })}>
                      <progress
                        aria-label={`Download progress for ${job.model}`}
                        max={measured ? job.totalBytes! : 1}
                        value={measured ? job.completedBytes! : undefined}
                        className={css({
                          w: "full",
                          h: "2",
                          appearance: "none",
                          border: "none",
                          color: "accent",
                          bg: "line",
                          "&::-webkit-progress-bar": { bg: "line" },
                          "&::-webkit-progress-value": { bg: "accent" },
                          "&::-moz-progress-bar": { bg: "accent" },
                        })}
                      />
                      {progress && (
                        <p className={`${muted} ${css({ fontSize: "xs", mt: "1" })}`}>
                          Current layer {job.digest?.replace(/^sha256:/, "").slice(0, 12)} ·{" "}
                          {job.completedBytes === null
                            ? "Transferred size unknown"
                            : bytes(job.completedBytes)}
                          {job.totalBytes !== null
                            ? ` of ${bytes(job.totalBytes)}`
                            : " · Total size unknown"}
                        </p>
                      )}
                      <Button
                        variant="ghost"
                        disabled={jobs.pending}
                        onClick={() => void jobs.cancel(job.id)}
                      >
                        Cancel download
                      </Button>
                    </div>
                  )}
                  {job.state === "cancelled" && (
                    <p className={`${muted} ${css({ fontSize: "xs", mt: "2" })}`}>
                      This request stopped. Ollama may keep cached layers or continue a download
                      requested elsewhere.
                    </p>
                  )}
                  {(job.state === "failed" || job.state === "cancelled") && (
                    <Button
                      variant="ghost"
                      disabled={!canStart || !!jobs.uncertain}
                      onClick={() => {
                        setModel(job.model);
                        void jobs.start(job.model);
                      }}
                    >
                      Retry download
                    </Button>
                  )}
                  {job.state === "completed" &&
                    (chatReady ? (
                      <Link
                        to="/playground"
                        search={{ model: job.model }}
                        className={`${button({ variant: "secondary" })} ${css({ mt: "3" })}`}
                      >
                        Try downloaded model
                      </Link>
                    ) : (
                      <div className={css({ mt: "2" })}>
                        <p className={`${muted} ${css({ fontSize: "xs" })}`}>
                          {installed
                            ? chatUnavailableReason(installed) ||
                              "Reconnect the runtime to try this model."
                            : errors.models
                              ? "Download finished, but the library could not be checked."
                              : "Download finished. Check the library to confirm it is available."}
                        </p>
                        <Button variant="ghost" onClick={() => void refresh()}>
                          Check model library
                        </Button>
                      </div>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
        <p className={`${muted} ${css({ mt: "4", fontSize: "10px" })}`}>
          The latest 20 download records are kept until the gateway restarts. Model files stay in
          Ollama. Downloading does not start inference or share a model.
        </p>
      </div>
    </section>
  );
}
