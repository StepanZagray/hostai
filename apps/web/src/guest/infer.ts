import { guestFetch, type GuestSession } from "./session";
import { guestInferSocket } from "./socket";

const MAX_REQUEST_BYTES = 262_144;
const encoder = new TextEncoder();

/**
 * One model-UI inference on the guest channel (docs/model-ui.md, "Guest API additions").
 * Local preview posts `{ model, input }` to /guest/v1/infer with the bearer key in the
 * Authorization header; temporary internet access sends the same payload as the first
 * WebSocket message. The key never travels anywhere else, and never reaches the frame.
 */
export function guestInfer(
  key: string,
  session: Pick<GuestSession, "model" | "scope">,
  input: unknown,
  signal: AbortSignal,
): Promise<Response> {
  if (session.scope === "temporary-internet")
    return guestInferSocket(key, session.model, input, signal);
  let body: string;
  try {
    body = JSON.stringify({ model: session.model, input });
    if (typeof body !== "string" || encoder.encode(body).byteLength > MAX_REQUEST_BYTES)
      throw new Error("Invalid client request.");
  } catch {
    // Structured clone can carry values JSON cannot (BigInt); the frame gets a plain error.
    return Promise.reject(new Error("Invalid client request."));
  }
  return guestFetch("/guest/v1/infer", key, { method: "POST", signal, body });
}
