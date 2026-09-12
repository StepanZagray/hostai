import { Link } from "@tanstack/react-router";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { Download, RefreshCw } from "lucide-react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { useModelDownloadSession } from "../lib/model-download-context";
import { downloadModelError } from "../lib/model-downloads";
import { starterModels } from "../lib/starter-models";
import { chatUnavailableReason } from "../lib/model-admission";
import {
  Badge,
  Button,
  Disclosure,
  ExternalLink,
  Note,
  Section,
  button,
  caption,
  control,
  fieldLabel,
  mono,
  muted,
} from "./ui";
import { UnreportedDownloads } from "./unreported-downloads";

const sizes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const bytes = (value: number) =>
  value >= 1e9 ? `${sizes.format(value / 1e9)} GB` : `${sizes.format(value / 1e6)} MB`;

export function ModelDownloads() {
  const { status, models, errors, refresh } = useHost();
  const jobs = useModelDownloadSession();
  const { modelDraft: model, editModel: setModel, submitted, setSubmitted } = jobs;
  const modelInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const statusPrefix = useId();
  const focusedDownload = useRef<{ id: string; element: HTMLElement } | null>(null);
  useEffect(() => {
    const focusMoved = (event: FocusEvent) => {
      if (event.target !== focusedDownload.current?.element) focusedDownload.current = null;
    };
    const pointerMoved = (event: PointerEvent) => {
      if (event.target instanceof Node && !focusedDownload.current?.element.contains(event.target))
        focusedDownload.current = null;
    };
    document.addEventListener("focusin", focusMoved, true);
    document.addEventListener("pointerdown", pointerMoved, true);
    return () => {
      document.removeEventListener("focusin", focusMoved, true);
      document.removeEventListener("pointerdown", pointerMoved, true);
    };
  }, []);
  // Layout changes can disable or remove the focused action, even without a new job list.
  useLayoutEffect(() => {
    const focused = focusedDownload.current;
    if (!focused || (focused.element.isConnected && !focused.element.matches(":disabled"))) return;
    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body && activeElement !== focused.element) {
      focusedDownload.current = null;
      return;
    }
    focusedDownload.current = null;
    const heading = panelRef.current?.querySelector<HTMLElement>(
      `[data-download-heading="${focused.id}"], [data-unreported-download="${focused.id}"]`,
    );
    const target =
      heading ?? (!modelInput.current?.disabled ? modelInput.current : null) ?? panelRef.current;
    target?.focus({ preventScroll: true });
  });
  const editingDisabled = jobs.loading || jobs.pending || !!jobs.uncertain;
  const selected = jobs.uncertain?.model ?? model.trim();
  const starter = starterModels.find((item) => item.tag === selected);
  const installedSelection = models.find((item) => item.name === selected);
  const canTry =
    !!status?.ollamaConnected &&
    installedSelection &&
    chatUnavailableReason(installedSelection) === null &&
    !jobs.pending &&
    !jobs.uncertain;
  const validation = downloadModelError(selected);
  const active = jobs.downloads.find((job) => job.state === "running");
  const canStart =
    !!status?.ollamaConnected && !jobs.loading && !jobs.statusError && !jobs.pending && !active;
  return (
    <Section
      ref={panelRef}
      tabIndex={-1}
      aria-label="Model downloads"
      title="Download a model"
      description="Pull a model from the Ollama library onto this host."
      className={css({ mb: "5" })}
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>("[data-download-row]");
        focusedDownload.current = row?.dataset.downloadRow
          ? { id: row.dataset.downloadRow, element: event.target }
          : null;
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (canStart && !validation) void jobs.start(selected);
        }}
      >
        <div
          className={css({
            display: "grid",
            gridTemplateColumns: { base: "1fr", md: "1fr 1fr" },
            gap: { base: "3", md: "4" },
            mb: "3",
          })}
        >
          <div className={css({ display: "grid", gap: "1.5", minW: 0, alignContent: "start" })}>
            <label htmlFor="starter-model" className={fieldLabel}>
              Choose a starter model
            </label>
            <select
              id="starter-model"
              value={starter?.tag ?? ""}
              disabled={editingDisabled}
              aria-describedby="starter-help download-help"
              onChange={(event) => {
                setModel(event.target.value);
                setSubmitted(false);
              }}
              className={control}
            >
              <option value="" disabled>
                Choose a starter, or enter a tag below
              </option>
              {starterModels.map((item) => (
                <option key={item.tag} value={item.tag}>
                  {item.tag} · ≈{item.size}
                  {models.some((model) => model.name === item.tag) ? " · Installed" : ""}
                </option>
              ))}
            </select>
            <span id="starter-help" className={caption}>
              Picking one fills the tag. It does not start the download.
            </span>
          </div>
          <div className={css({ display: "grid", gap: "1.5", minW: 0, alignContent: "start" })}>
            <label htmlFor="download-model" className={fieldLabel}>
              Model and tag
            </label>
            <input
              ref={modelInput}
              id="download-model"
              value={jobs.uncertain?.model ?? model}
              onChange={(event) => setModel(event.target.value)}
              disabled={editingDisabled}
              aria-describedby={
                submitted && validation ? "download-help download-error" : "download-help"
              }
              aria-invalid={submitted && !!validation}
              placeholder="qwen3:0.6b"
              autoComplete="off"
              spellCheck={false}
              className={`${control} ${css({ fontFamily: "mono" })}`}
            />
            {submitted && validation && (
              <span
                id="download-error"
                role="alert"
                className={css({ fontSize: "xs", color: "stop", lineHeight: 1.55 })}
              >
                {validation}
              </span>
            )}
          </div>
        </div>
        <div
          className={css({
            display: "flex",
            alignItems: "center",
            gap: "2",
            flexWrap: "wrap",
            mb: "3",
          })}
        >
          <Button
            variant={canTry ? "secondary" : "primary"}
            type="submit"
            disabled={!canStart}
            aria-describedby={[
              "download-help",
              !status?.ollamaConnected && "download-offline",
              jobs.loading && "download-loading",
              jobs.statusError && "download-status-error",
              active && "download-active",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <Download size={15} />
            {jobs.pending
              ? "Working…"
              : jobs.uncertain
                ? "Retry start request"
                : installedSelection
                  ? "Download again"
                  : "Download model"}
          </Button>
          {canTry && (
            <Link
              to="/playground"
              search={{ model: selected }}
              className={button({ variant: "primary" })}
            >
              Try installed model
            </Link>
          )}
        </div>
        <div className={css({ display: "grid", gap: "1.5", minW: 0 })}>
          <p id="download-help" className={caption}>
            {starter
              ? `Listed model size: approximately ${starter.size}. ${starter.description} `
              : "Enter an explicit model:tag. Download size is unknown for custom tags. "}
            File size is not RAM or VRAM needed to run it, and HostAI has checked neither.
          </p>
          {starter && (
            <div className={css({ display: "grid", gap: "0.5", minW: 0 })}>
              <p className={caption}>
                {starter.label} · Listing checked 10 Sep 2026; size and requirements can change.
              </p>
              <ExternalLink href={starter.source}>Model details and terms on Ollama</ExternalLink>
            </div>
          )}
          {installedSelection && (
            <div role="status" className={css({ display: "grid", gap: "1", minW: 0 })}>
              <p className={caption}>
                This exact tag is already installed. Download again checks for updated files.
              </p>
              {chatUnavailableReason(installedSelection) !== null && (
                <p className={css({ color: "amber", fontSize: "xs", lineHeight: 1.55 })}>
                  {chatUnavailableReason(installedSelection)}
                </p>
              )}
            </div>
          )}
          <div>
            <ExternalLink href="https://ollama.com/library">
              Browse model names and requirements
            </ExternalLink>
          </div>
        </div>
      </form>
      {!status?.ollamaConnected && (
        <Note id="download-offline" tone="warning" className={css({ mt: "3" })}>
          Connect Ollama on this host before downloading. <Link to="/connection">Open setup</Link>
        </Note>
      )}
      {jobs.loading && (
        <p id="download-loading" role="status" className={`${muted} ${css({ mt: "3" })}`}>
          Checking downloads…
        </p>
      )}
      {jobs.statusError && (
        <div className={css({ mt: "3", display: "grid", gap: "2", justifyItems: "start" })}>
          <Note
            id="download-status-error"
            role="alert"
            tone="warning"
            className={css({ w: "full" })}
          >
            {jobs.statusError} Saved progress may be out of date.
          </Note>
          <Button disabled={jobs.refreshing} onClick={() => void jobs.refresh()}>
            <RefreshCw size={15} />
            {jobs.refreshing ? "Checking download status…" : "Check download status"}
          </Button>
        </div>
      )}
      {jobs.actionError && (
        <Note role="alert" tone="danger" className={css({ mt: "3" })}>
          {jobs.actionError}
        </Note>
      )}
      {jobs.uncertain && (
        <div className={css({ mt: "3", display: "grid", gap: "1.5" })}>
          <div
            className={css({ display: "flex", alignItems: "center", gap: "2", flexWrap: "wrap" })}
          >
            {!jobs.statusError && (
              <Button disabled={jobs.refreshing} onClick={() => void jobs.refresh()}>
                <RefreshCw size={15} />
                {jobs.refreshing ? "Checking download status…" : "Check download status"}
              </Button>
            )}
            <Button disabled={jobs.pending} onClick={jobs.dismissUncertain}>
              Use a different model
            </Button>
          </div>
          <p className={caption}>
            Changing the entry does not cancel a download the gateway may have accepted.
          </p>
        </div>
      )}
      {active && (
        <p id="download-active" className={`${caption} ${css({ mt: "3" })}`}>
          One download at a time. It continues when you leave this page; keep the gateway running.
        </p>
      )}
      {jobs.downloads.length > 0 && (
        <ul className={css({ mt: "4", minW: 0 })}>
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
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "2",
                    flexWrap: "wrap",
                    minW: 0,
                  })}
                >
                  <h3
                    tabIndex={-1}
                    data-download-heading={job.id}
                    aria-describedby={`${statusPrefix}-${job.id}`}
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
                  <Badge
                    tone={
                      job.state === "completed"
                        ? "good"
                        : job.state === "failed"
                          ? "warning"
                          : job.state === "running"
                            ? "busy"
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
                  id={`${statusPrefix}-${job.id}`}
                  role="status"
                  aria-atomic="true"
                  className={`${caption} ${css({ mt: "1" })}`}
                >
                  {job.error || job.message}
                </p>
                {job.state === "running" && (
                  <div className={css({ mt: "2.5", display: "grid", gap: "2", minW: 0 })}>
                    <progress
                      aria-label={`Download progress for ${job.model}`}
                      max={measured ? job.totalBytes! : 1}
                      value={measured ? job.completedBytes! : undefined}
                      className={css({
                        display: "block",
                        w: "full",
                        h: "4px",
                        appearance: "none",
                        border: "none",
                        borderRadius: "full",
                        overflow: "hidden",
                        color: "live",
                        bg: "well",
                        "&::-webkit-progress-bar": { bg: "well" },
                        "&::-webkit-progress-value": { bg: "live" },
                        "&::-moz-progress-bar": { bg: "live" },
                      })}
                    />
                    <div
                      className={css({
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "2",
                        flexWrap: "wrap",
                        minW: 0,
                      })}
                    >
                      {progress && (
                        <p
                          className={`${caption} ${mono} ${css({
                            fontVariantNumeric: "tabular-nums",
                            minW: 0,
                          })}`}
                        >
                          Current layer {job.digest?.replace(/^sha256:/, "").slice(0, 12)} ·{" "}
                          {job.completedBytes === null
                            ? "Transferred size unknown"
                            : bytes(job.completedBytes)}
                          {job.totalBytes !== null
                            ? ` of ${bytes(job.totalBytes)}`
                            : " · Total size unknown"}
                        </p>
                      )}
                      <button
                        type="button"
                        className={`${button({ variant: "ghost", size: "sm" })} ${css({ ml: "auto" })}`}
                        disabled={jobs.pending}
                        onClick={() => void jobs.cancel(job.id)}
                      >
                        Cancel download
                      </button>
                    </div>
                  </div>
                )}
                {job.state === "cancelled" && (
                  <p className={`${caption} ${css({ mt: "1" })}`}>
                    This request stopped. Ollama may keep cached layers or continue a download
                    requested elsewhere.
                  </p>
                )}
                {(job.state === "failed" || job.state === "cancelled") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={css({ mt: "2" })}
                    disabled={!canStart || !!jobs.uncertain}
                    onClick={() => {
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
                      className={`${button({ size: "sm" })} ${css({ mt: "2.5" })}`}
                    >
                      Try downloaded model
                    </Link>
                  ) : (
                    <div
                      className={css({
                        mt: "1.5",
                        display: "grid",
                        gap: "1.5",
                        justifyItems: "start",
                      })}
                    >
                      <p className={caption}>
                        {installed
                          ? chatUnavailableReason(installed) ||
                            "Reconnect the runtime to try this model."
                          : errors.models
                            ? "Download finished, but the library could not be checked."
                            : "Download finished. Check the library to confirm it is available."}
                      </p>
                      <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                        Check model library
                      </Button>
                    </div>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {jobs.unreported.length > 0 && !jobs.statusError && !jobs.uncertain && (
        <Button
          className={css({ mt: "3" })}
          disabled={jobs.refreshing}
          onClick={() => void jobs.refresh()}
        >
          <RefreshCw size={15} />
          {jobs.refreshing ? "Checking download status…" : "Check download status"}
        </Button>
      )}
      <UnreportedDownloads
        downloads={jobs.unreported}
        restartDisabled={!canStart || !!jobs.uncertain}
        dismissDisabled={jobs.pending || !!jobs.uncertain}
        onRestart={(tag) => {
          void jobs.start(tag);
        }}
        onDismiss={(id) => {
          jobs.dismissUnreported(id);
          modelInput.current?.focus();
        }}
      />
      <Disclosure summary="What downloading does and does not do" className={css({ mt: "4" })}>
        <p>
          The gateway keeps the last 20 download records until it restarts. Model files stay in
          Ollama.
        </p>
        <p>Downloading does not start inference or share a model with anyone.</p>
        <p>
          This tab keeps your entry and up to 20 missing-download notices while you navigate.
          Reloading or closing it clears them.
        </p>
      </Disclosure>
    </Section>
  );
}
