import { z } from 'zod';

/** Everything a tool may know about the caller. Comes from the session, never from the model. */
export interface ToolContext {
  userId: string;
  timezone: string;
}

/** Human-readable description of a mutating call, shown on the confirmation card. */
export interface ActionSummary {
  title: string;
  details: Record<string, string>;
  /**
   * The item as it was when the card was built, for tools that change or
   * remove an existing one (see `lookup`). Loaded by the server, so the card
   * shows what is really affected, not what the model claims.
   */
  before?: unknown;
}

/**
 * A tool is described once: the zod schema produces both the JSON Schema the
 * model sees and the runtime validation of whatever the model sends.
 */
export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Mutating tools run only after the user confirms. */
  mutating: boolean;
  execute(ctx: ToolContext, input: z.output<S>): Promise<unknown>;
  /**
   * Mutating tools that act on an existing item: loads it before the
   * confirmation card is shown. Throw a ToolError when it does not exist, so
   * the model gets the error instead of the user getting a card.
   */
  lookup?(ctx: ToolContext, input: z.output<S>): Promise<unknown>;
  /** Required for mutating tools. `before` is what `lookup` returned. */
  summarize?(input: z.output<S>, before?: unknown): ActionSummary;
  /**
   * Reverts a successful run, given what `execute` returned. Only for
   * mutating tools; the user triggers it from the resolved card.
   */
  undo?(ctx: ToolContext, result: unknown): Promise<void>;
}

export type AnyTool = ToolDefinition<any>;

export function defineTool<S extends z.ZodType>(
  def: ToolDefinition<S>,
): ToolDefinition<S> {
  if (def.mutating && !def.summarize) {
    throw new Error(`Mutating tool ${def.name} needs summarize()`);
  }
  if (!def.mutating && (def.undo || def.lookup)) {
    throw new Error(
      `Read-only tool ${def.name} cannot have undo() or lookup()`,
    );
  }
  return def;
}

/** An error whose message is safe to show to the model and the user. */
export class ToolError extends Error {
  /** True when only signing in with Google again can fix it. */
  readonly reauthRequired: boolean;

  constructor(message: string, options: { reauthRequired?: boolean } = {}) {
    super(message);
    this.reauthRequired = options.reauthRequired ?? false;
  }
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...json } = z.toJSONSchema(schema, {
    io: 'input',
  }) as Record<string, unknown>;
  return json;
}
