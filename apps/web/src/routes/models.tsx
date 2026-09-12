import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RuntimeCommand } from "../components/runtime-command";
import { ModelDownloads } from "../components/model-downloads";
import { ArrowRight, Search, RefreshCw } from "lucide-react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { formatBytes } from "../lib/api";
import { interfaceUnavailableReason, modelInterface } from "../lib/model-admission";
import {
  Badge,
  Button,
  EmptyState,
  PageHeading,
  button,
  caption,
  control,
  mono,
  panel,
} from "../components/ui";

export const Route = createFileRoute("/models")({ component: Models });

function Models() {
  const { models, loading, refreshing, refresh, errors, status } = useHost();
  const [search, setSearch] = useState("");
  const filtered = models.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <PageHeading
        title="Your model library"
        description="Models installed in your runtime, with chat or their own interface."
        action={
          <Button disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw />
            Refresh models
          </Button>
        }
      />
      <ModelDownloads />
      <div
        className={css({
          mb: "3",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "3",
          flexWrap: "wrap",
        })}
      >
        <div
          className={css({
            display: "flex",
            alignItems: "center",
            position: "relative",
            width: { base: "full", sm: "300px" },
            minW: 0,
          })}
        >
          <Search
            size={15}
            aria-hidden="true"
            className={css({
              position: "absolute",
              left: "2.5",
              color: "muted",
              pointerEvents: "none",
            })}
          />
          <input
            aria-label="Search models"
            disabled={loading}
            placeholder="Filter by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${control} ${css({ pl: "8" })}`}
          />
        </div>
        <span className={`${caption} ${mono} ${css({ fontVariantNumeric: "tabular-nums" })}`}>
          {loading
            ? "Checking runtime models…"
            : errors.models
              ? "Model count unavailable"
              : `${models.length} discovered ${models.length === 1 ? "model" : "models"}`}
        </span>
      </div>
      <section className={`${panel} ${css({ overflow: "hidden" })}`} aria-busy={loading}>
        {loading ? (
          <EmptyState title="Looking for your models" description="Checking your local runtime…" />
        ) : errors.models ? (
          <EmptyState
            title="Model discovery unavailable"
            description="Your installed models could not be listed. Check Ollama, then refresh."
          />
        ) : !models.length ? (
          <EmptyState
            title="No installed models yet"
            description="Models appear here once Ollama finishes a download. Start one above."
            action={
              status?.ollamaConnected ? (
                <a href="#starter-model" className={button({ variant: "primary" })}>
                  Choose a starter
                  <ArrowRight size={15} />
                </a>
              ) : (
                <Link to="/connection" className={button({ variant: "primary" })}>
                  View setup
                  <ArrowRight size={15} />
                </Link>
              )
            }
          />
        ) : !filtered.length ? (
          <EmptyState
            title="No matching models"
            description={`Nothing installed matches “${search}”.`}
            action={<Button onClick={() => setSearch("")}>Clear search</Button>}
          />
        ) : (
          <ul>
            {filtered.map((model) => {
              const reason = interfaceUnavailableReason(model);
              return (
                <li
                  key={model.name}
                  className={css({
                    px: { base: "3.5", md: "4" },
                    py: "3",
                    display: "flex",
                    gap: { base: "2.5", md: "4" },
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    minW: 0,
                    borderTop: "1px solid token(colors.lineSoft)",
                    _first: { borderTop: "none" },
                  })}
                >
                  <div
                    className={css({
                      flex: "1 1 240px",
                      minW: 0,
                      display: "grid",
                      gap: "1",
                      alignContent: "start",
                    })}
                  >
                    <div
                      className={css({
                        display: "flex",
                        alignItems: "center",
                        gap: "2.5",
                        flexWrap: "wrap",
                        minW: 0,
                      })}
                    >
                      <h2
                        className={css({
                          fontFamily: "mono",
                          fontSize: "sm",
                          fontWeight: 600,
                          lineHeight: 1.4,
                          overflowWrap: "anywhere",
                          minW: 0,
                        })}
                      >
                        {model.name}
                      </h2>
                      <Badge tone={reason === null ? "good" : "warning"}>
                        {reason === null
                          ? "Available to try"
                          : modelInterface(model) === "unsupported"
                            ? "No supported interface"
                            : "Unavailable for chat"}
                      </Badge>
                    </div>
                    <p className={`${caption} ${mono}`}>
                      {[
                        model.parameterSize || "Unknown size",
                        model.sizeBytes > 0
                          ? formatBytes(model.sizeBytes)
                          : "No weight size reported",
                        model.quantization || "Quantization unknown",
                      ].join(" · ")}
                    </p>
                    {reason !== null && (
                      <p className={css({ color: "amber", fontSize: "xs", lineHeight: 1.55 })}>
                        {reason}
                      </p>
                    )}
                  </div>
                  {reason === null && (
                    <div
                      className={css({
                        display: "flex",
                        alignItems: "center",
                        gap: "2",
                        flexWrap: "wrap",
                      })}
                    >
                      <Link
                        to="/playground"
                        search={{ model: model.name }}
                        className={button({ size: "sm" })}
                      >
                        Try in playground <ArrowRight size={13} />
                      </Link>
                      <Link
                        to="/sharing"
                        search={{ model: model.name }}
                        className={button({ variant: "ghost", size: "sm" })}
                      >
                        Set up guest access
                      </Link>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <aside
        aria-label="Add a model from your terminal"
        className={css({
          mt: "5",
          p: { base: "3.5", md: "4" },
          bg: "paper",
          border: "1px solid token(colors.line)",
          borderRadius: "lg",
          minW: 0,
        })}
      >
        <h2 className={css({ fontSize: "sm", fontWeight: 600, mb: "2.5" })}>
          Add a model from your terminal
        </h2>
        <div className={css({ maxW: "640px", minW: 0 })}>
          <RuntimeCommand endpoint={status?.ollamaUrl} loading={loading} action="pull" />
        </div>
      </aside>
      <p className={`${caption} ${css({ mt: "4" })}`}>
        Model files live in Ollama. HostAI reads the library and never deletes anything.
      </p>
    </>
  );
}
