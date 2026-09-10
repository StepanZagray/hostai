import type { ModelDownload } from "./model-downloads";

export interface DownloadHistory {
  downloads: ModelDownload[];
  unreported: ModelDownload[];
}

// A missing running record is an unknown outcome, not evidence of completion or
// cancellation. Terminal records can simply age out of the gateway's history.
export function reconcileDownloads(
  previous: DownloadHistory,
  downloads: ModelDownload[],
): DownloadHistory {
  const reported = new Set(downloads.map((job) => job.id));
  const missing = previous.downloads.filter(
    (job) => job.state === "running" && !reported.has(job.id),
  );
  return {
    downloads,
    unreported: [...missing, ...previous.unreported.filter((job) => !reported.has(job.id))].slice(
      0,
      20,
    ),
  };
}

export function mergeDownload(previous: DownloadHistory, job: ModelDownload): DownloadHistory {
  return {
    downloads: [job, ...previous.downloads.filter((item) => item.id !== job.id)].slice(0, 20),
    unreported: previous.unreported.filter((item) => item.id !== job.id),
  };
}
