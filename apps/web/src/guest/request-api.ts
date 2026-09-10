export type RequestHello =
  | {
      version: 1;
      scope: "temporary-internet";
      requestsAccepted: true;
      intakeId: string;
      hostLabel: string | null;
      model: string;
    }
  | {
      version: 1;
      scope: "temporary-internet";
      requestsAccepted: false;
      intakeId: null;
      hostLabel: null;
      model: null;
    };

export interface AccessRequest {
  version: 1;
  id: string;
  state: "pending" | "approved" | "rejected" | "cancelled" | "expired" | "revoked" | "failed";
  code: string;
  name: string;
  model: string;
  channel: "internet";
  expiresInSeconds: number;
  grantId: string | null;
  grantExpiresAt: string | null;
}

export interface RequestBody {
  readonly intakeId: string;
  readonly name: string;
  readonly model: string;
  readonly accessCommitment: string;
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));

export function parseRequestHello(value: unknown): RequestHello | null {
  if (!record(value) || value.version !== 1 || value.scope !== "temporary-internet") return null;
  if (value.requestsAccepted === false) {
    return value.intakeId === null && value.hostLabel === null && value.model === null
      ? {
          version: 1,
          scope: "temporary-internet",
          requestsAccepted: false,
          intakeId: null,
          hostLabel: null,
          model: null,
        }
      : null;
  }
  if (
    value.requestsAccepted !== true ||
    !uuid(value.intakeId) ||
    (value.hostLabel !== null && typeof value.hostLabel !== "string") ||
    typeof value.model !== "string" ||
    !value.model.trim()
  )
    return null;
  return {
    version: 1,
    scope: "temporary-internet",
    requestsAccepted: true,
    intakeId: value.intakeId,
    hostLabel: value.hostLabel,
    model: value.model,
  };
}

export function parseAccessRequest(
  value: unknown,
  expected: Pick<RequestBody, "name" | "model">,
  previous: AccessRequest | null = null,
): AccessRequest | null {
  if (
    !record(value) ||
    value.version !== 1 ||
    !uuid(value.id) ||
    typeof value.state !== "string" ||
    !["pending", "approved", "rejected", "cancelled", "expired", "revoked", "failed"].includes(
      value.state,
    ) ||
    typeof value.code !== "string" ||
    ![6, 7].includes(value.code.length) ||
    !/^[0-9A-HJKMNP-TV-Z]{3}-?[0-9A-HJKMNP-TV-Z]{3}$/.test(value.code) ||
    typeof value.name !== "string" ||
    value.name.length > 40 ||
    !value.name.trim() ||
    value.name !== expected.name ||
    value.model !== expected.model ||
    typeof value.model !== "string" ||
    value.channel !== "internet" ||
    typeof value.expiresInSeconds !== "number" ||
    !Number.isInteger(value.expiresInSeconds) ||
    value.expiresInSeconds < 0 ||
    value.expiresInSeconds > 900 ||
    (value.grantId !== null && !uuid(value.grantId)) ||
    (value.grantExpiresAt !== null && !isoDate(value.grantExpiresAt)) ||
    (value.grantId === null) !== (value.grantExpiresAt === null) ||
    (value.state === "approved" && value.grantId === null) ||
    (value.state === "pending" && value.grantId !== null)
  )
    return null;
  const code = value.code.replace("-", "");
  if (
    previous &&
    (value.id !== previous.id ||
      code !== previous.code ||
      (previous.grantId !== null &&
        value.state === "approved" &&
        value.grantId !== previous.grantId) ||
      (previous.state !== "pending" && value.state === "pending") ||
      (isRequestTerminal(previous.state) && value.state !== previous.state))
  )
    return null;
  // Copy only protocol metadata: never retain arbitrary response fields in React state.
  return {
    version: 1,
    id: value.id,
    state: value.state as AccessRequest["state"],
    code,
    name: value.name,
    model: value.model,
    channel: "internet",
    expiresInSeconds: value.expiresInSeconds,
    grantId: value.grantId,
    grantExpiresAt: value.grantExpiresAt,
  };
}

export const isRequestTerminal = (state: AccessRequest["state"]) =>
  state !== "pending" && state !== "approved";

export function requestProblem(status: number): string {
  switch (status) {
    case 400:
      return "The host could not accept these request details. Refresh the host details before trying again.";
    case 401:
    case 403:
      return "The host could not verify this request. Retry the same request or ask the host for an access key.";
    case 404:
      return "Access requests are unavailable at this address. You can still connect with an existing key.";
    case 409:
    case 410:
      return "The host’s access intake changed or ended. Refresh the host details; your current request is retained.";
    case 429:
      return "The host is busy or its request limit was reached. Wait for the retry timer, then retry.";
    case 503:
      return "The host is unavailable. Retry when it is online, or use an existing key.";
    default:
      return "Could not confirm the response from the host. Retry the same action; any existing request is retained.";
  }
}

export class RequestApiError extends Error {
  constructor(
    readonly status = 0,
    readonly retrySeconds = 0,
  ) {
    super(requestProblem(status));
  }
}

// An HTTP-date is only a backoff hint, never the clock for request/grant expiry.
export function requestRetrySeconds(response: Response): number {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value || value.length > 100) return 5;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(60, Math.max(1, Math.ceil(seconds))) : 5;
}

type RequestPath =
  | "/guest/v1/hello"
  | "/guest/v1/requests"
  | "/guest/v1/requests/self"
  | "/guest/v1/requests/self/cancel";

/** Fixed same-origin endpoints. Credentials are only ever carried in the Authorization header. */
export async function requestJson(
  path: RequestPath,
  signal: AbortSignal,
  requestSecret?: string,
  body?: Readonly<RequestBody> | Record<string, never>,
): Promise<unknown> {
  if (typeof window === "undefined" || window.location.protocol !== "https:")
    throw new RequestApiError();
  const json = body === undefined ? undefined : JSON.stringify(body);
  const post = path === "/guest/v1/requests" || path === "/guest/v1/requests/self/cancel";
  if (post !== (json !== undefined)) throw new RequestApiError();
  if (json !== undefined && new TextEncoder().encode(json).byteLength > 2048)
    throw new RequestApiError(400);
  if (
    (path === "/guest/v1/hello" && (requestSecret !== undefined || json !== undefined)) ||
    (path !== "/guest/v1/hello" &&
      (typeof requestSecret !== "string" ||
        requestSecret.length !== 43 ||
        !/^[A-Za-z0-9_-]+$/.test(requestSecret)))
  )
    throw new RequestApiError();
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 10_000);
  let rejectAborted: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => {
      void reader?.cancel().catch(() => {});
      reject(new RequestApiError());
    };
    controller.signal.addEventListener("abort", rejectAborted, { once: true });
    if (controller.signal.aborted) rejectAborted();
  });
  try {
    return await Promise.race([
      aborted,
      (async () => {
        if (controller.signal.aborted) throw new RequestApiError();
        const response = await fetch(path, {
          method: post ? "POST" : "GET",
          body: json,
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
          mode: "same-origin",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            Accept: "application/json",
            ...(json === undefined ? {} : { "Content-Type": "application/json" }),
            ...(requestSecret === undefined
              ? {}
              : { Authorization: `Bearer hgq1.${requestSecret}` }),
          },
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new RequestApiError();
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new RequestApiError(
            response.status,
            response.status === 429 ? requestRetrySeconds(response) : 0,
          );
        }
        if (
          !response.headers
            .get("Content-Type")
            ?.toLowerCase()
            .split(";")[0]
            .trim()
            .endsWith("/json") ||
          Number(response.headers.get("Content-Length")) > 32768 ||
          !response.body
        ) {
          void response.body?.cancel().catch(() => {});
          throw new RequestApiError();
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "";
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw new RequestApiError();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32768) throw new RequestApiError();
          text += decoder.decode(chunk.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode()) as unknown;
      })(),
    ]);
  } catch (error) {
    throw error instanceof RequestApiError ? error : new RequestApiError();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAborted);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    controller.abort();
  }
}
