import { describe, expect, it } from "vite-plus/test";
import { prepareChatRequest, type ConversationTurn } from "./conversation";

const settings = { temperature: 0.7, maxTokens: 128 };
function prepare(turns: ConversationTurn[], model: string, prompt: string) {
  const request = prepareChatRequest(turns, model, prompt, settings);
  if (request.error !== null) throw new Error(request.error);
  return request;
}
function chatHistory(turns: ConversationTurn[], model: string, prompt: string) {
  return prepare(turns, model, prompt).messages;
}

const completed: ConversationTurn = {
  id: "one",
  model: "test-model:small",
  prompt: "First question",
  response: "First answer",
  state: "completed",
};

describe("conversation context", () => {
  it("keeps long conversations within the gateway message limit", () => {
    const turns = Array.from({ length: 32 }, (_, i) => ({ ...completed, id: String(i) }));
    const request = prepareChatRequest(turns, completed.model, "Next", {
      temperature: 0.7,
      maxTokens: 128,
    });
    expect(request.error).toBeNull();
    if (request.error !== null) throw new Error(request.error);
    expect(request.messages.length).toBe(63);
    expect(request.omittedTurns).toBe(1);
  });
  it("keeps completed exchanges in order and excludes display metadata", () => {
    expect(
      chatHistory(
        [
          completed,
          { ...completed, id: "two", prompt: "Second question", response: "Second answer" },
        ],
        completed.model,
        "Follow up",
      ),
    ).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Second answer" },
      { role: "user", content: "Follow up" },
    ]);
  });
  it.each(["streaming", "failed", "cancelled"] as const)(
    "excludes the entire %s exchange without changing the visible history",
    (state) => {
      const interrupted = {
        ...completed,
        id: "unfinished",
        prompt: "Unfinished question",
        response: "Partial",
        state,
      };
      const turns = [completed, interrupted];
      expect(chatHistory(turns, completed.model, "Try again")).toEqual([
        { role: "user", content: completed.prompt },
        { role: "assistant", content: completed.response },
        { role: "user", content: "Try again" },
      ]);
      expect(turns[1].response).toBe("Partial");
      expect(turns[1].state).toBe(state);
    },
  );
  it.each(["", " \n\t"])(
    "does not forward blank assistant content rejected by the gateway",
    (response) => {
      expect(chatHistory([{ ...completed, response }], completed.model, "Next")).toEqual([
        { role: "user", content: "Next" },
      ]);
    },
  );
  it("does not mix exchanges from different models", () => {
    expect(chatHistory([completed], "other-model", "Hello")).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });
});

describe("request context budgets", () => {
  it("does not let failed exchanges displace completed context at the message limit", () => {
    const turns = Array.from({ length: 31 }, (_, i) => ({ ...completed, id: String(i) }));
    const failed = Array.from({ length: 64 }, (_, i) => ({
      ...completed,
      id: `failed-${i}`,
      state: "failed" as const,
    }));
    const request = prepare([...turns, ...failed], completed.model, "Next");
    expect(request.messages).toHaveLength(63);
    expect(request.includedTurns).toBe(31);
    expect(request.omittedTurns).toBe(0);
  });

  it("keeps exactly 65536 content code units and drops a whole turn above it", () => {
    const older = { ...completed, prompt: "a".repeat(16384), response: "b".repeat(16383) };
    const newer = {
      ...completed,
      id: "two",
      prompt: "c".repeat(16384),
      response: "d".repeat(16384),
    };
    const atLimit = prepare([older, newer], completed.model, "x");
    expect(atLimit.messages.reduce((n, message) => n + message.content.length, 0)).toBe(65536);
    expect(atLimit.omittedTurns).toBe(0);
    const overLimit = prepare([older, newer], completed.model, "xx");
    expect(overLimit.omittedTurns).toBe(1);
    expect(overLimit.messages).toEqual([
      { role: "user", content: newer.prompt },
      { role: "assistant", content: newer.response },
      { role: "user", content: "xx" },
    ]);
  });

  it("stops at an oversized historical answer without reviving older context", () => {
    const boundary = { ...completed, id: "boundary", response: "a".repeat(16384) };
    const newest = { ...completed, id: "newest", prompt: "Recent", response: "Recent answer" };
    expect(prepare([completed, boundary, newest], completed.model, "Next").includedTurns).toBe(3);
    const turns = [completed, { ...boundary, response: boundary.response + "a" }, newest];
    const original = structuredClone(turns);
    const request = prepare(turns, completed.model, "Next");
    expect(request.omittedTurns).toBe(2);
    expect(request.messages).toEqual(chatHistory([newest], completed.model, "Next"));
    expect(turns).toEqual(original);
  });

  it("measures exact serialized body bytes including escaping and request settings", () => {
    const turn = { ...completed, prompt: "\0".repeat(16384), response: "\0".repeat(16384) };
    const prefix = "\0".repeat(10000);
    const initialBody = JSON.stringify({
      model: completed.model,
      messages: [
        { role: "user", content: turn.prompt },
        { role: "assistant", content: turn.response },
        { role: "user", content: prefix },
      ],
      ...settings,
    });
    const prompt = prefix + "a".repeat(262144 - new TextEncoder().encode(initialBody).length);
    const atLimit = prepare([turn], completed.model, prompt);
    expect(prompt.length).toBeLessThanOrEqual(16384);
    expect(atLimit.omittedTurns).toBe(0);
    expect(new TextEncoder().encode(atLimit.body)).toHaveLength(262144);
    expect(JSON.parse(atLimit.body)).toEqual({
      model: completed.model,
      messages: atLimit.messages,
      ...settings,
    });
    const overLimit = prepare([turn], completed.model, prompt + "a");
    expect(overLimit.omittedTurns).toBe(1);
    expect(overLimit.messages).toEqual([{ role: "user", content: prompt + "a" }]);
  });

  it("counts UTF-16 units without cutting Unicode or trimming the newest message", () => {
    const turn = { ...completed, response: "🙂".repeat(8192) };
    const prompt = "  Next 🙂 漢字\n";
    expect(prepare([turn], completed.model, prompt).includedTurns).toBe(1);
    const request = prepare([{ ...turn, response: turn.response + "🙂" }], completed.model, prompt);
    expect(request.omittedTurns).toBe(1);
    expect(request.messages).toEqual([{ role: "user", content: prompt }]);
    expect(JSON.parse(request.body).messages).toEqual(request.messages);
  });

  it("does not charge incomplete assistant output against the context budget", () => {
    const turn = { ...completed, state: "cancelled" as const, response: "a".repeat(20000) };
    const request = prepare([turn], completed.model, "Try again");
    expect(request.omittedTurns).toBe(0);
    expect(request.messages).toEqual([{ role: "user", content: "Try again" }]);
  });

  it("rejects invalid new prompts instead of shortening them", () => {
    expect(prepareChatRequest([], completed.model, " \n", settings).error).toBe("Enter a message.");
    expect(prepare([], completed.model, "a".repeat(16384)).messages[0].content).toHaveLength(16384);
    expect(prepareChatRequest([], completed.model, "a".repeat(16385), settings).error).toMatch(
      /too long/,
    );
  });
});
