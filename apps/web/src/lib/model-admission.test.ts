import { describe, expect, it } from "vite-plus/test";
import { normalizeCapabilities, type Model } from "./api";
import {
  chatUnavailableReason,
  interfaceUnavailableReason,
  modelInterface,
  NO_SUPPORTED_INTERFACE,
} from "./model-admission";

const base: Model = {
  name: "runtime:latest",
  sizeBytes: 1,
  parameterSize: "",
  quantization: "",
  modifiedAt: "",
  chatUnavailableReason: null,
  ui: null,
};
const ui = { runtime: "runtime", entry: "ui/index.html" };

describe("model interface admission", () => {
  it("requires chat capability for the default UI and infer capability for a custom UI", () => {
    for (const chat of [false, true]) {
      for (const infer of [false, true]) {
        for (const custom of [false, true]) {
          const model = { ...base, ui: custom ? ui : null, capabilities: { chat, infer } };
          const expected = custom && infer ? "custom" : chat ? "chat" : "unsupported";
          expect(modelInterface(model)).toBe(expected);
          expect(interfaceUnavailableReason(model)).toBe(
            expected === "unsupported" ? NO_SUPPORTED_INTERFACE : null,
          );
          expect(chatUnavailableReason(model) === null).toBe(chat);
        }
      }
    }
  });

  it("preserves legacy chat and custom models while keeping missing chat admission unknown", () => {
    expect(interfaceUnavailableReason(base)).toBeNull();
    expect(
      interfaceUnavailableReason({ ...base, chatUnavailableReason: undefined } as unknown as Model),
    ).toContain("unknown");
    expect(
      interfaceUnavailableReason({ ...base, ui, chatUnavailableReason: "Use its own interface." }),
    ).toBeNull();
    expect(
      interfaceUnavailableReason({ ...base, chatUnavailableReason: "Remote model blocked." }),
    ).toBe("Remote model blocked.");
  });

  it("does not coerce malformed explicit capabilities into permission", () => {
    for (const value of [null, {}, true, "chat", { chat: "true", infer: false }, { chat: true }]) {
      const capabilities = normalizeCapabilities(value, ui);
      expect(modelInterface({ ui, capabilities })).toBe("unsupported");
    }
    expect(normalizeCapabilities(undefined, null)).toEqual({ chat: true, infer: false });
    expect(normalizeCapabilities(undefined, ui)).toEqual({ chat: false, infer: true });
  });
});
