import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Box, Search, RefreshCw, Terminal } from "lucide-react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { formatBytes } from "../lib/api";
import {
  Badge,
  Button,
  CodeBlock,
  EmptyState,
  PageHeading,
  button,
  muted,
  panel,
} from "../components/ui";

export const Route = createFileRoute("/models")({ component: Models });
function Models() {
  const { models, loading, refreshing, refresh, errors } = useHost();
  const [search, setSearch] = useState("");
  const filtered = models.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <PageHeading
        title="Your model library"
        description="Discover what’s installed. Find the right model for your next idea."
        action={
          <Button disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw />
            Refresh models
          </Button>
        }
      />
      <div
        className={css({
          mb: "6",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "4",
          flexWrap: "wrap",
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
            width: { base: "full", sm: "320px" },
            color: "muted",
          })}
        >
          <Search size={17} />
          <input
            aria-label="Search installed models"
            disabled={loading}
            placeholder="Search your models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={css({ minH: "44px", w: "full", bg: "transparent", outlineOffset: "-2px" })}
          />
        </label>
        <span className={muted}>
          {loading
            ? "Checking installed models…"
            : errors.models
              ? "Model count unavailable"
              : `${models.length} installed ${models.length === 1 ? "model" : "models"}`}
        </span>
      </div>
      <section className={panel} aria-busy={loading}>
        {loading ? (
          <EmptyState
            icon={<Box size={22} />}
            title="Looking for your models"
            description="Checking your local runtime…"
          />
        ) : errors.models ? (
          <EmptyState
            icon={<Box size={26} />}
            title="Model discovery unavailable"
            description="Your installed models could not be checked. Check Ollama and retry the refresh."
          />
        ) : !models.length ? (
          <EmptyState
            icon={<Box size={26} />}
            title="Your library starts here"
            description="Download your first model with Ollama, then refresh this library. Start small and choose a model that fits your machine."
            action={
              <Link to="/connection" className={button({ variant: "primary" })}>
                View setup
                <ArrowRight size={15} />
              </Link>
            }
          />
        ) : !filtered.length ? (
          <EmptyState
            icon={<Search size={22} />}
            title="No matching models"
            description={`No installed model matches “${search}”. Try a different name.`}
            action={<Button onClick={() => setSearch("")}>Clear search</Button>}
          />
        ) : (
          <div
            className={css({
              display: "grid",
              gridTemplateColumns: { base: "1fr", lg: "1fr 1fr" },
            })}
          >
            {filtered.map((model) => (
              <article
                key={model.name}
                className={css({
                  p: "6",
                  borderBottom: "1px solid token(colors.line)",
                  borderRight: "1px solid token(colors.line)",
                })}
              >
                <div className={css({ display: "flex", justifyContent: "space-between", mb: "5" })}>
                  <span
                    className={css({
                      bg: "accentSoft",
                      color: "accent",
                      p: "3",
                      borderRadius: "9px",
                    })}
                  >
                    <Box size={22} />
                  </span>
                  <Badge tone="good">Installed</Badge>
                </div>
                <h2
                  className={css({
                    fontFamily: "mono",
                    fontSize: "16px",
                    fontWeight: 600,
                    overflowWrap: "anywhere",
                    mb: "2",
                  })}
                >
                  {model.name}
                </h2>
                <p className={muted}>
                  Local model · {model.parameterSize || "Unknown parameter size"}
                </p>
                <div
                  className={css({
                    display: "flex",
                    gap: "5",
                    my: "5",
                    fontSize: "xs",
                    color: "muted",
                  })}
                >
                  <span>{formatBytes(model.sizeBytes)}</span>
                  <span>{model.quantization || "Quantization unavailable"}</span>
                </div>
                <Link
                  to="/playground"
                  search={{ model: model.name }}
                  className={button({ variant: "secondary" })}
                >
                  Try in playground
                  <ArrowRight size={14} />
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
      <aside
        className={css({
          mt: "6",
          p: "5",
          border: "1px dashed #c9d7e0",
          borderRadius: "10px",
          display: "flex",
          alignItems: { base: "start", lg: "center" },
          gap: "4",
          flexDirection: { base: "column", lg: "row" },
        })}
      >
        <Terminal size={21} className={css({ color: "accent" })} />
        <div className={css({ flex: 1 })}>
          <h2 className={css({ fontSize: "sm", fontWeight: 700, mb: "1" })}>
            Add a model from your terminal
          </h2>
          <p className={muted}>
            Downloads are managed by Ollama. HostAI discovers them after refresh.
          </p>
        </div>
        <div className={css({ maxW: "full" })}>
          <CodeBlock code="ollama pull qwen3:0.6b" />
        </div>
      </aside>
    </>
  );
}
