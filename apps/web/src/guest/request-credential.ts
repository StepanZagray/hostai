/** Credentials remain in the requesting tab. Only the access-secret hash is submitted for approval. */
export interface RequestCredential {
  requestSecret: string;
  accessSecret: string;
  accessCommitment: string;
}

const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function createRequestCredential(): Promise<RequestCredential> {
  const request = new Uint8Array(32);
  const access = new Uint8Array(32);
  try {
    crypto.getRandomValues(request);
    crypto.getRandomValues(access);
    const commitment = new Uint8Array(await crypto.subtle.digest("SHA-256", access));
    return {
      requestSecret: encode(request),
      accessSecret: encode(access),
      accessCommitment: Array.from(commitment, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ),
    };
  } finally {
    request.fill(0);
    access.fill(0);
  }
}

export function approvedAccessKey(grantId: string, accessSecret: string): string {
  // IDs are assigned by the host. Never turn arbitrary response text into a credential.
  if (!uuid.test(grantId) || !/^[A-Za-z0-9_-]{43}$/.test(accessSecret)) {
    throw new Error("Invalid approved access credential");
  }
  const bytes = Uint8Array.from(
    atob(accessSecret.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
  try {
    if (bytes.length !== 32 || encode(bytes) !== accessSecret)
      throw new Error("Invalid approved access credential");
    return `hga1.${grantId}.${accessSecret}`;
  } finally {
    bytes.fill(0);
  }
}
