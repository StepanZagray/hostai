import { describe, expect, it } from "vite-plus/test";
import { chatHistory, type ConversationTurn } from "./conversation";

const completed: ConversationTurn = {
  id: "one",
  model: "test-model:small",
  prompt: "First question",
  response: "First answer",
  state: "completed",
};

describe("conversation context", () => {
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
    "excludes the %s answer while preserving all user messages",
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
        { role: "user", content: "Unfinished question" },
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
        { role: "user", content: completed.prompt },
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
