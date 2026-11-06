/**
 * Provider-neutral boundary for chat models. Content blocks are stored and
 * replayed as opaque JSON so provider-specific blocks (thinking, tool_use)
 * survive a round trip through the database unchanged.
 */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ChatRequest {
  system: string;
  messages: ChatTurn[];
  signal?: AbortSignal;
}

export interface ChatResult {
  /** Blocks safe to append to history and send back on the next turn. */
  content: ContentBlock[];
  /** `end_turn`, `max_tokens`, `refusal`, ... */
  stopReason: string | null;
  model: string;
  usage: Record<string, unknown>;
}

export type ChatStreamEvent =
  { type: 'text'; text: string } | { type: 'done'; result: ChatResult };

export abstract class LlmProvider {
  abstract streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent>;
}
