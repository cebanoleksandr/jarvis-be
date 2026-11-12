import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import {
  type ChatRequest,
  type ChatStreamEvent,
  type ChatTurn,
  type ContentBlock,
  LlmProvider,
  textBlock,
  type ToolCall,
} from './llm.types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
/** Free models are rate limited and overloaded often; wait and try again. */
const RETRY_DELAYS_MS = [1500, 4000];

/** A message in the OpenAI chat-completions format that OpenRouter speaks. */
export type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface StreamChunk {
  model?: string;
  error?: { message?: string; code?: number | string };
  usage?: Record<string, unknown>;
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
}

/**
 * Any model on OpenRouter through its OpenAI-compatible API. History stays in
 * the canonical (Anthropic-style) blocks and is translated here, so a
 * conversation can be continued after switching providers.
 */
@Injectable()
export class OpenRouterProvider extends LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.apiKey = config.get('OPENROUTER_API_KEY', { infer: true }) ?? '';
    this.model = config.get('LLM_MODEL', { infer: true });
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const res = await this.request(req);

    let text = '';
    let model = this.model;
    let finishReason: string | null = null;
    let usage: Record<string, unknown> = {};
    const calls: { id: string; name: string; args: string }[] = [];

    for await (const chunk of readSse(res.body!)) {
      if (chunk.error) {
        throw new Error(
          `OpenRouter stream error: ${chunk.error.message ?? chunk.error.code}`,
        );
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (choice.delta?.content) {
        text += choice.delta.content;
        yield { type: 'text', text: choice.delta.content };
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        // Fragments of one call share an index; id and name come first.
        const call = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name = tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
    }

    const seen = new Set<string>();
    const toolCalls: ToolCall[] = calls.filter(Boolean).map((c) => {
      // Some models omit or repeat ids; results are matched by id later.
      const id = c.id && !seen.has(c.id) ? c.id : `call_${randomUUID()}`;
      seen.add(id);
      return { id, name: c.name, input: parseArguments(c.args) };
    });
    const content: ContentBlock[] = [
      ...(text ? [textBlock(text)] : []),
      ...toolCalls.map((c) => ({ type: 'tool_use', ...c })),
    ];
    yield {
      type: 'done',
      result: {
        content,
        toolCalls,
        stopReason: toStopReason(finishReason, toolCalls.length > 0),
        model,
        usage,
      },
    };
  }

  private async request(req: ChatRequest): Promise<Response> {
    const body = JSON.stringify({
      model: this.model,
      stream: true,
      // No max_tokens: output limits differ per model, OpenRouter applies the model's own.
      messages: toOpenAiMessages(req.system, req.messages),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              },
            })),
          }
        : {}),
    });

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: req.signal,
      });
      if (res.ok && res.body) return res;

      const detail = await errorDetail(res);
      const retryable = res.status === 429 || res.status >= 500;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) {
        throw new Error(`OpenRouter request failed (${res.status}): ${detail}`);
      }
      await sleep(delay, req.signal);
    }
  }
}

/** Canonical history -> OpenAI messages. Thinking and other provider-only blocks are dropped. */
export function toOpenAiMessages(
  system: string,
  turns: ChatTurn[],
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const turn of turns) {
    const text = turn.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n\n');

    if (turn.role === 'assistant') {
      const toolCalls = turn.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id as string,
          type: 'function' as const,
          function: {
            name: b.name as string,
            arguments: JSON.stringify(b.input ?? {}),
          },
        }));
      if (!text && !toolCalls.length) continue;
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // Tool results must directly follow the assistant message that asked for them.
    for (const b of turn.content) {
      if (b.type !== 'tool_result') continue;
      const result =
        typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      out.push({
        role: 'tool',
        tool_call_id: b.tool_use_id as string,
        content: b.is_error ? `Error: ${result}` : result,
      });
    }
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

/** Unparseable arguments are passed on so tool validation reports them to the model. */
export function parseArguments(args: string): unknown {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return { _unparsed: args };
  }
}

export function toStopReason(
  finishReason: string | null,
  hasToolCalls: boolean,
): string | null {
  // Some models report `stop` even though they asked for tools.
  if (hasToolCalls) return 'tool_use';
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    // A tool call was announced but none arrived: treat as a normal end.
    case 'tool_calls':
      return 'end_turn';
    default:
      return finishReason;
  }
}

/** Parses a `text/event-stream` body into JSON chunks; skips comments and `[DONE]`. */
export async function* readSse(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = function* (line: string): Generator<StreamChunk> {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    yield JSON.parse(data) as StreamChunk;
  };
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) yield* parse(line);
  }
  yield* parse(buffer + decoder.decode());
}

async function errorDetail(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed.error?.message ?? raw.slice(0, 500);
  } catch {
    return raw.slice(0, 500) || res.statusText;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
