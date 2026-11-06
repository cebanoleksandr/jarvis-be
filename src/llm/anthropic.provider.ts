import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import {
  type ChatRequest,
  type ChatStreamEvent,
  type ContentBlock,
  LlmProvider,
} from './llm.types.js';

@Injectable()
export class AnthropicProvider extends LlmProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: Env['LLM_EFFORT'];
  private readonly maxTokens: number;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.client = new Anthropic({
      apiKey: config.get('ANTHROPIC_API_KEY', { infer: true }),
    });
    this.model = config.get('LLM_MODEL', { infer: true });
    this.effort = config.get('LLM_EFFORT', { infer: true });
    this.maxTokens = config.get('LLM_MAX_TOKENS', { infer: true });
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        thinking: { type: 'adaptive' },
        output_config: { effort: this.effort },
        // On a safety-classifier refusal the API retries on the recommended
        // fallback model inside the same stream.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // Auto-cache the growing conversation prefix.
        cache_control: { type: 'ephemeral' },
        system: req.system,
        messages: req.messages as Anthropic.Beta.BetaMessageParam[],
      },
      { signal: req.signal },
    );

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { type: 'text', text: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    yield {
      type: 'done',
      result: {
        content: sanitizeForHistory(
          message.content as unknown as ContentBlock[],
        ),
        stopReason: message.stop_reason,
        model: message.model,
        usage: message.usage as unknown as Record<string, unknown>,
      },
    };
  }
}

/**
 * After a mid-output fallback, only text from the declined partial may be sent
 * back; thinking, tool_use and other model-internal blocks before the last
 * `fallback` marker must be dropped. The marker itself is an audit-only block.
 */
export function sanitizeForHistory(content: ContentBlock[]): ContentBlock[] {
  const boundary = content.findLastIndex((b) => b.type === 'fallback');
  if (boundary === -1) return content;
  return [
    ...content.slice(0, boundary).filter((b) => b.type === 'text'),
    ...content.slice(boundary + 1),
  ];
}
