import type { ChatMessage } from "./api";

export interface ConversationTurn {
  id: string;
  model: string;
  prompt: string;
  response: string;
  state: "streaming" | "completed" | "failed" | "cancelled";
}

// Keep what the user said, but never tell the model it completed an interrupted
// or blank answer. Project explicit wire messages so UI metadata stays local.
export function chatHistory(
  turns: ConversationTurn[],
  model: string,
  prompt: string,
): ChatMessage[] {
  return [
    ...turns
      .filter((turn) => turn.model === model)
      .flatMap((turn): ChatMessage[] => [
        { role: "user", content: turn.prompt },
        ...(turn.state === "completed" && turn.response.trim()
          ? [{ role: "assistant" as const, content: turn.response }]
          : []),
      ]),
    { role: "user", content: prompt },
  ];
}
