import { createFileRoute } from "@tanstack/react-router";
import { css } from "../../styled-system/css";
import { DirectoryPage } from "../directory/directory-page";
import { usePublication } from "../directory/use-publication";
import { Button, PageHeading, muted, panel } from "../components/ui";
export const Route = createFileRoute("/hosts")({ component: FindHosts });
function FindHosts() {
  const { status, error, loading, refresh } = usePublication();
  if (status?.configured && status.registryUrl)
    return (
      <DirectoryPage
        key={status.registryUrl}
        embedded
        registryOrigin={new URL(status.registryUrl).origin}
      />
    );
  return (
    <>
      <PageHeading
        title="Find a model host"
        description="Search a shared directory, then open a host’s guest chat with your invitation."
      />
      <section className={`${panel} ${css({ p: "6" })}`} aria-label="Directory setup">
        <h2 className={css({ fontSize: "lg", fontWeight: 700 })}>
          {loading && !status
            ? "Checking directory setup…"
            : error
              ? "Directory setup unavailable"
              : "Choose a shared directory"}
        </h2>
        <p className={`${muted} ${css({ mt: "3" })}`}>
          This workspace has no built-in public registry. Configure HOSTAI_DIRECTORY_URL on the
          gateway and restart it to browse a directory you trust. A directory operator can also
          share its browser page, which works without installing HostAI.
        </p>
        <p className={`${muted} ${css({ mt: "3" })}`}>
          If you already have an invitation, open the host’s link directly. The directory does not
          issue access keys or verify host identities.
        </p>
        {error && (
          <p role="alert" className={css({ color: "warning", mt: "3" })}>
            {error}
          </p>
        )}
        <Button className={css({ mt: "4" })} disabled={loading} onClick={() => void refresh()}>
          Check directory setup
        </Button>
      </section>
    </>
  );
}
