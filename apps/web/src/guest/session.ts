export interface GuestSession {
  hostLabel: string;
  model: string;
  expiresAt: string;
  available: boolean;
  unavailableReason: string | null;
  maxConcurrentGuests: 1;
  maxTokens: 1024;
  requestsPerMinute: 6;
  scope: "local-preview" | "temporary-internet";
}

let invite: string | null = null;

export function captureInvite() {
  const fragment = window.location.hash;
  if (fragment) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    invite = new URLSearchParams(fragment.slice(1)).get("access");
  }
}

export function takeInvite() {
  const key = invite;
  invite = null;
  return key;
}

export function parseSession(value: unknown): GuestSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Partial<GuestSession>;
  return typeof session.hostLabel === "string" &&
    typeof session.model === "string" &&
    session.model.trim().length > 0 &&
    typeof session.expiresAt === "string" &&
    Number.isFinite(Date.parse(session.expiresAt)) &&
    typeof session.available === "boolean" &&
    (session.unavailableReason === null || typeof session.unavailableReason === "string") &&
    session.maxConcurrentGuests === 1 &&
    session.maxTokens === 1024 &&
    session.requestsPerMinute === 6 &&
    (session.scope === "local-preview" || session.scope === "temporary-internet")
    ? (session as GuestSession)
    : null;
}

export const validKeyLength = (key: string) => key.length > 0 && key.length <= 256;

// Never render server error bodies or thrown messages: they may echo credentials.
export function responseProblem(status: number) {
  switch (status) {
    case 401:
      return "A valid access key is required. This key may be invalid, expired, or revoked.";
    case 403:
      return "This key does not permit the selected model. Reconnect to check permissions.";
    case 408:
      return "The message upload timed out. Reconnect, then try sending again.";
    case 429:
      return "The host is busy or the request limit was reached. Reconnect before trying again.";
    case 503:
      return "Guest chat is stopped or the host is offline. Reconnect when it is available.";
    default:
      return "The host could not complete this request. Reconnect to check guest access.";
  }
}

export function retryAfter(response: Response): number {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return 0;
  const until = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, until) : 0;
}

export function guestFetch(
  path: "/guest/v1/session" | "/guest/v1/chat",
  key: string,
  init: RequestInit,
) {
  return fetch(path, {
    ...init,
    credentials: "omit",
    cache: "no-store",
    mode: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: {
      Accept: path.endsWith("/chat") ? "application/x-ndjson" : "application/json",
      ...(path.endsWith("/chat") ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${key}`,
    },
  });
}
