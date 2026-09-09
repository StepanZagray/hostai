import { describe, expect, it } from "vite-plus/test";
import { readChatStream } from "./api";

describe("chat stream protocol", () => {
  it("handles fragmented JSON, UTF-8 and the final record without a newline", async () => {
    const bytes = new TextEncoder().encode(
      '{"content":"héllo 🌍","done":false}\n{"content":"","done":true,"outputTokens":3}',
    );
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );
    const chunks: string[] = [];
    await readChatStream(response, (chunk) => chunks.push(chunk.content));
    expect(chunks.join("")).toBe("héllo 🌍");
  });
  it("rejects truncated streams instead of reporting a completed generation", async () => {
    await expect(
      readChatStream(new Response('{"content":"partial","done":false}\n'), () => {}),
    ).rejects.toThrow("before the model finished");
  });
  it("surfaces midstream failures", async () => {
    await expect(
      readChatStream(
        new Response('{"content":"","done":true,"error":"Runtime disconnected"}\n'),
        () => {},
      ),
    ).rejects.toThrow("Runtime disconnected");
  });
  it("surfaces structured gateway errors", async () => {
    await expect(
      readChatStream(
        Response.json({ detail: "No generation slots available" }, { status: 429 }),
        () => {},
      ),
    ).rejects.toThrow("No generation slots available");
  });
});
