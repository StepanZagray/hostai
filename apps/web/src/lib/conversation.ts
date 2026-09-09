import type { ChatMessage } from "./api";

export interface ConversationTurn {
  id: string;
  model: string;
  prompt: string;
  response: string;
  state: "streaming" | "completed" | "failed" | "cancelled";
  omittedTurns?: number;
}

function turnMessages(turn: ConversationTurn): ChatMessage[] {
  return [
    { role: "user", content: turn.prompt },
    ...(turn.state === "completed" && turn.response.trim()
      ? [{ role: "assistant" as const, content: turn.response }]
      : []),
  ];
}

type PreparedChatRequest =
  | { error: string }
  | {
      error: null;
      body: string;
      messages: ChatMessage[];
      omittedTurns: number;
      includedTurns: number;
    };

// These are gateway transport/validation limits, not the model's token window.
const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 16_384;
const MAX_CONTENT_CHARS = 65_536;
const MAX_BODY_BYTES = 262_144;

export function prepareChatRequest(
  turns: ConversationTurn[],
  model: string,
  prompt: string,
  settings: { temperature: number; maxTokens: number },
): PreparedChatRequest {
  if (!prompt.trim()) return { error: "Enter a message." };
  if (prompt.length > MAX_MESSAGE_CHARS)
    return { error: "This message is too long. Shorten it before sending." };
  const serialize = (messages: ChatMessage[]) =>
    JSON.stringify({
      model,
      messages,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    });
  const bytes = (body: string) => new TextEncoder().encode(body).byteLength;
  let messages: ChatMessage[] = [{ role: "user", content: prompt }];
  let body = serialize(messages);
  if (bytes(body) > MAX_BODY_BYTES)
    return { error: "This message is too large. Shorten it before sending." };
  const matching = turns.filter((turn) => turn.model === model);
  let includedTurns = 0;
  // Work backwards, keeping a contiguous suffix of whole exchanges. Stop at
  // the first boundary rather than skipping a large turn and reviving older context.
  for (let i = matching.length - 1; i >= 0; i--) {
    const previous = turnMessages(matching[i]);
    if (
      previous.some(
        (message) => !message.content.trim() || message.content.length > MAX_MESSAGE_CHARS,
      )
    )
      break;
    const candidate = [...previous, ...messages];
    if (
      candidate.length > MAX_MESSAGES ||
      candidate.reduce((total, message) => total + message.content.length, 0) > MAX_CONTENT_CHARS
    )
      break;
    const candidateBody = serialize(candidate);
    if (bytes(candidateBody) > MAX_BODY_BYTES) break;
    messages = candidate;
    body = candidateBody;
    includedTurns++;
  }
  return {
    error: null,
    messages,
    body,
    includedTurns,
    omittedTurns: matching.length - includedTurns,
  };
}
