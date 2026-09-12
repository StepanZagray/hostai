import { normalizeCapabilities, type Model, type ModelCapabilities, type ModelUi } from "./api";

export const NO_SUPPORTED_INTERFACE =
  "This model provides neither a supported chat interface nor a usable custom interface. Choose another model or ask the provider to enable one.";

/** Presentation is selected from declared contracts, not inferred agent-loop ownership. */
export function modelInterface(model: { ui: ModelUi | null; capabilities?: ModelCapabilities }) {
  const capabilities = normalizeCapabilities(model.capabilities, model.ui);
  if (model.ui && capabilities.infer) return "custom";
  return capabilities.chat ? "chat" : "unsupported";
}

export function interfaceUnavailableReason(model: Model): string | null {
  switch (modelInterface(model)) {
    case "custom":
      return null;
    case "chat":
      return chatUnavailableReason(model);
    case "unsupported":
      return NO_SUPPORTED_INTERFACE;
  }
}

// Java supplies known admission restrictions. Missing metadata is unknown, not approval.
export function chatUnavailableReason(model: Model): string | null {
  if (!normalizeCapabilities(model.capabilities, model.ui).chat)
    return "This model does not support chat.";
  if (model.chatUnavailableReason === null) return null;
  if (typeof model.chatUnavailableReason === "string" && model.chatUnavailableReason.trim())
    return model.chatUnavailableReason;
  return "Model availability is unknown. Update and restart the gateway, then refresh.";
}
