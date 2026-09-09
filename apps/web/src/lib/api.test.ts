import { describe, expect, it, vi } from "vite-plus/test";
import { readChatStream } from "./api";

describe("chat stream protocol", () => {
  it("finishes and cancels the transport as soon as the terminal record arrives", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"content":"Final answer","done":true,"outputTokens":7}\n'),
          );
          // Deliberately leave the socket open after the protocol has finished.
        },
        cancel,
      }),
    );
    const onChunk = vi.fn();
    await readChatStream(response, onChunk);
    expect(onChunk).toHaveBeenCalledExactlyOnceWith({
      content: "Final answer",
      done: true,
      outputTokens: 7,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
  it("ignores records and malformed data after the terminal record", async () => {
    const onChunk = vi.fn();
    await readChatStream(
      new Response('{"content":"Done","done":true}\n{"content":"Extra","done":false}\ninvalid\n'),
      onChunk,
    );
    expect(onChunk).toHaveBeenCalledExactlyOnceWith({ content: "Done", done: true });
  });
  it.each([
    "not JSON",
    '{"content":',
    "null",
    "[]",
    '{"content":5,"done":true}',
    '{"content":"","done":"true"}',
    '{"content":"","done":true,"outputTokens":-1}',
    '{"content":"","done":true,"outputTokens":1.5}',
    '{"content":"","done":true,"error":{}}',
  ])("rejects invalid protocol records: %s", async (record) => {
    await expect(readChatStream(new Response(record), () => {})).rejects.toThrow("invalid stream");
  });
  it("cancels and unlocks the stream when rendering a chunk fails", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":"Partial","done":false}\n'));
        },
        cancel,
      }),
    );
    await expect(
      readChatStream(response, () => {
        throw new Error("Render failed");
      }),
    ).rejects.toThrow("Render failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
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
