import { Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import { GoogleToolsService } from '../google/google-tools.service.js';
import { TrelloToolsService } from '../trello/trello-tools.service.js';
import type { ToolSpec } from '../llm/llm.types.js';
import {
  type AnyTool,
  type ToolContext,
  ToolError,
  toJsonSchema,
} from './tool.js';

export type ToolOutcome =
  { ok: true; result: unknown } | { ok: false; error: string };

export type PreparedCall =
  | { kind: 'invalid'; error: string }
  | { kind: 'ready'; tool: AnyTool; input: Record<string, unknown> };

/** Tool results are capped so one call cannot flood the context window. */
const MAX_RESULT_CHARS = 20_000;

@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, AnyTool>();
  private readonly toolSpecs: ToolSpec[];

  constructor(google: GoogleToolsService, trello: TrelloToolsService) {
    for (const tool of [...google.tools, ...trello.tools]) this.register(tool);
    // Sorted so the tool list (the start of the prompt) is byte-stable for caching.
    this.toolSpecs = [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toJsonSchema(t.input),
      }));
  }

  register(tool: AnyTool) {
    if (this.tools.has(tool.name))
      throw new Error(`Duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  specs(): ToolSpec[] {
    return this.toolSpecs;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  /** Validates model-supplied input against the tool's schema. */
  prepare(name: string, input: unknown): PreparedCall {
    const tool = this.tools.get(name);
    if (!tool) return { kind: 'invalid', error: `Unknown tool: ${name}` };
    const parsed = tool.input.safeParse(input) as z.ZodSafeParseResult<unknown>;
    if (!parsed.success) {
      return {
        kind: 'invalid',
        error: `Invalid input for ${name}: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      };
    }
    return {
      kind: 'ready',
      tool,
      input: parsed.data as Record<string, unknown>,
    };
  }

  execute(
    tool: AnyTool,
    ctx: ToolContext,
    input: unknown,
  ): Promise<ToolOutcome> {
    return this.run(tool, () => tool.execute(ctx, input));
  }

  /** The item a mutating tool would change, for its confirmation card. */
  lookup(
    tool: AnyTool,
    ctx: ToolContext,
    input: unknown,
  ): Promise<ToolOutcome> {
    return tool.lookup
      ? this.run(tool, () => tool.lookup!(ctx, input))
      : Promise.resolve({ ok: true, result: undefined });
  }

  private async run(
    tool: AnyTool,
    fn: () => Promise<unknown>,
  ): Promise<ToolOutcome> {
    try {
      return { ok: true, result: await fn() };
    } catch (err) {
      if (err instanceof ToolError) return { ok: false, error: err.message };
      this.logger.error(
        `Tool ${tool.name} failed: ${(err as Error).stack ?? String(err)}`,
      );
      return {
        ok: false,
        error: `${tool.name} failed unexpectedly. Try again later.`,
      };
    }
  }
}

export function renderToolResult(result: unknown): string {
  const text = JSON.stringify(result ?? null);
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]`
    : text;
}
