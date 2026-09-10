export interface OwnerRequest {
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
  requestedAt: string;
}

export interface RequestsStatus {
  enabled: boolean;
  available: boolean;
  intakeId: string | null;
  remainingGrantSlots: number;
  remainingRequestSlots: number;
  items: OwnerRequest[];
}

export interface RequestSharingStatus {
  state: string;
  model: string | null;
  internet?: { state: string };
  requests?: RequestsStatus;
}

export type RequestAction =
  | { type: "start" }
  | { type: "stop" }
  | { type: "refresh" }
  | { type: "approve"; id: string; code: string; expiresInHours: number }
  | { type: "reject"; id: string; code: string };

export const requestStates: Record<OwnerRequest["state"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
  expired: "Expired",
  revoked: "Revoked",
  failed: "Failed",
};

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Missing requests is an older gateway; malformed or unknown versions fail closed. */
export function parseRequests(value: unknown): RequestsStatus | undefined {
  if (value === undefined) return undefined;
  const invalid = () => {
    throw new Error(
      "Guest access request status could not be read. Refresh status before approving access.",
    );
  };
  if (
    !record(value) ||
    typeof value.enabled !== "boolean" ||
    typeof value.available !== "boolean" ||
    !(value.intakeId === null || uuid(value.intakeId)) ||
    !integer(value.remainingGrantSlots, 100) ||
    !integer(value.remainingRequestSlots, 20) ||
    !Array.isArray(value.items) ||
    value.items.length > 100
  )
    return invalid();
  if (
    (value.enabled && value.intakeId === null) ||
    (value.available &&
      (!value.enabled || !value.remainingGrantSlots || !value.remainingRequestSlots))
  )
    return invalid();
  const ids = new Set<string>();
  const items: OwnerRequest[] = [];
  for (const item of value.items) {
    if (
      !record(item) ||
      item.version !== 1 ||
      !uuid(item.id) ||
      ids.has(item.id.toLowerCase()) ||
      typeof item.state !== "string" ||
      !Object.hasOwn(requestStates, item.state) ||
      typeof item.code !== "string" ||
      !/^[0-9A-HJKMNP-TV-Z]{3}-?[0-9A-HJKMNP-TV-Z]{3}$/i.test(item.code) ||
      typeof item.name !== "string" ||
      item.name.length > 40 ||
      typeof item.model !== "string" ||
      item.channel !== "internet" ||
      !integer(item.expiresInSeconds, 900) ||
      !(item.grantId === null || uuid(item.grantId)) ||
      !(item.grantExpiresAt === null || timestamp(item.grantExpiresAt)) ||
      !timestamp(item.requestedAt) ||
      (item.state === "approved" && (item.grantId === null || item.grantExpiresAt === null))
    )
      return invalid();
    ids.add(item.id.toLowerCase());
    items.push(item as unknown as OwnerRequest);
  }
  if (items.filter((item) => item.state === "pending").length > 10) return invalid();
  return {
    enabled: value.enabled,
    available: value.available,
    intakeId: value.intakeId,
    remainingGrantSlots: value.remainingGrantSlots,
    remainingRequestSlots: value.remainingRequestSlots,
    items,
  };
}

export function hasRequestCapacity(status: RequestsStatus) {
  return status.remainingGrantSlots > 0 && status.remainingRequestSlots > 0;
}

// Shared by the controls and the page's existing serialized mutation entry point.
export function canRequestAction(
  action: RequestAction,
  status: RequestSharingStatus | null,
  ready: boolean,
  approvalUncertain = false,
) {
  if (action.type === "stop" || action.type === "refresh") return true;
  const requests = status?.requests;
  if (!ready || !requests || status.state !== "local" || status.internet?.state !== "live")
    return false;
  if (action.type === "start") return !requests.enabled && hasRequestCapacity(requests);
  const item = requests.items.find((item) => item.id === action.id && item.code === action.code);
  if (
    !requests.enabled ||
    !item ||
    item.state !== "pending" ||
    item.expiresInSeconds === 0 ||
    item.model !== status.model
  )
    return false;
  // Reject remains useful when capacity is full; it cannot issue a key.
  if (action.type === "reject") return true;
  return (
    !approvalUncertain &&
    requests.available &&
    hasRequestCapacity(requests) &&
    Number.isInteger(action.expiresInHours) &&
    action.expiresInHours >= 1 &&
    action.expiresInHours <= 168
  );
}
