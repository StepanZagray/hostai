export interface Listing {
  id: string;
  hostLabel: string;
  model: string;
  guestUrl: string;
  updatedAt: number;
  expiresAt: number;
  invitationRequired: true;
}
export interface DirectorySnapshot {
  servedAt: number;
  listings: Listing[];
}

export function guestAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100) return null;
  try {
    const url = new URL(value);
    return url.href === value &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(url.hostname)
      ? value
      : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const timestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

export function parseDirectory(value: unknown): DirectorySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    data.version !== 1 ||
    !timestamp(data.servedAt) ||
    !Array.isArray(data.listings) ||
    data.listings.length > 100
  )
    return null;
  const ids = new Set<string>();
  const listings: Listing[] = [];
  for (const entry of data.listings) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.id) ||
      ids.has(item.id) ||
      !text(item.hostLabel, 80) ||
      !text(item.model, 200) ||
      !guestAddress(item.guestUrl) ||
      !timestamp(item.updatedAt) ||
      !timestamp(item.expiresAt) ||
      item.updatedAt > data.servedAt ||
      item.expiresAt !== item.updatedAt + 90_000 ||
      item.invitationRequired !== true
    )
      return null;
    ids.add(item.id);
    listings.push({
      id: item.id,
      hostLabel: item.hostLabel,
      model: item.model,
      guestUrl: item.guestUrl as string,
      updatedAt: item.updatedAt,
      expiresAt: item.expiresAt,
      invitationRequired: true,
    });
  }
  return { servedAt: data.servedAt, listings };
}

// Use registry time plus elapsed monotonic time, not the guest machine's wall clock.
export function fresh(listing: Listing, snapshot: DirectorySnapshot, elapsedMs: number): boolean {
  return listing.expiresAt > snapshot.servedAt + Math.max(0, elapsedMs);
}

export async function readBoundedJson(response: Response, limit = 131_072): Promise<unknown> {
  if (
    !response.ok ||
    response.headers.get("Content-Type")?.split(";", 1)[0] !== "application/json" ||
    !response.body
  )
    throw new Error("Directory unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Directory response too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readDirectory(
  signal: AbortSignal,
  endpoint: "/registry/v1/listings" | "/api/directory/listings",
): Promise<DirectorySnapshot> {
  const response = await fetch(endpoint, {
    signal,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  const snapshot = parseDirectory(await readBoundedJson(response));
  if (!snapshot) throw new Error("Unsupported directory response");
  return snapshot;
}
