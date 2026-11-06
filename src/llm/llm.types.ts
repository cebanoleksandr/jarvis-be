/**
 * Provider-neutral boundary for chat models.
 *
 * Content blocks are stored and replayed as opaque JSON so provider-specific
 * blocks (thinking, tool_use) survive a round trip through the database. The
 * canonical shapes for text, tool_use and tool_result follow the Anthropic
 * Messages format; another provider would translate at its own edge.
 */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatRequest {
  system: string;
  messages: ChatTurn[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export interface ChatResult {
  /** Blocks safe to append to history and send back on the next turn. */
  content: ContentBlock[];
  /** `end_turn`, `tool_use`, `max_tokens`, `refusal`, ... */
  stopReason: string | null;
  toolCalls: ToolCall[];
  model: string;
  usage: Record<string, unknown>;
}

export type ChatStreamEvent =
  { type: 'text'; text: string } | { type: 'done'; result: ChatResult };

export abstract class LlmProvider {
  abstract streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

export function toolResultBlock(
  toolUseId: string,
  content: string,
  isError = false,
): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(isError ? { is_error: true } : {}),
  };
}

export function toolUseIds(content: ContentBlock[]): string[] {
  return content
    .filter((b) => b.type === 'tool_use' && typeof b.id === 'string')
    .map((b) => b.id as string);
}
