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
  /** Required for mutating tools. */
  summarize?(input: z.output<S>): ActionSummary;
}

export type AnyTool = ToolDefinition<any>;

export function defineTool<S extends z.ZodType>(
  def: ToolDefinition<S>,
): ToolDefinition<S> {
  if (def.mutating && !def.summarize) {
    throw new Error(`Mutating tool ${def.name} needs summarize()`);
  }
  return def;
}

/** An error whose message is safe to show to the model and the user. */
export class ToolError extends Error {}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...json } = z.toJSONSchema(schema, {
    io: 'input',
  }) as Record<string, unknown>;
  return json;
}
