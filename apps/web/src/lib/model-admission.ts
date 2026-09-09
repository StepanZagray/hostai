import type { Model } from "./api";

// Java supplies known admission restrictions. Missing metadata is unknown, not approval.
export function chatUnavailableReason(model: Model): string | null {
  if (model.chatUnavailableReason === null) return null;
  if (typeof model.chatUnavailableReason === "string" && model.chatUnavailableReason.trim())
    return model.chatUnavailableReason;
  return "Model availability is unknown. Update and restart the gateway, then refresh.";
}
