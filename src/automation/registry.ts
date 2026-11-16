/**
 * The Claude connector's tool registry. Each tool is defined once — name,
 * description, JSON Schema input, MCP annotations, handler — and both
 * `window.sleap.automation` and the MCP server's tools/list + tools/call are
 * built from it, so the two can't drift.
 *
 * Results use MCP's content shape. Handlers throw `AutomationError` for bad
 * input or a state the user must fix (no QC run, …); the MCP layer turns
 * those into `isError` results the model can read.
 */
import { AutomationError } from "./errors";

/** The subset of JSON Schema the tools use (validated by {@link validateArgs}). */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ObjectSchema extends JsonSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** MCP tool annotations (hints for the client; not enforced). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  annotations: ToolAnnotations;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
}

/** What tools/list shows: everything but the handler. */
export type ToolInfo = Omit<Tool, "handler">;

export const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const typeOf = (v: unknown): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
};

const matchesType = (v: unknown, type: string) => {
  const t = typeOf(v);
  return t === type || (type === "number" && t === "integer");
};

/** Check `value` against `schema`; returns a readable problem or null. */
export function validateArgs(schema: JsonSchema, value: unknown, path = "arguments"): string | null {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      return `${path} should be ${types.join(" or ")}, got ${typeOf(value)}`;
    }
  }
  if (typeof value === "number" && !Number.isFinite(value)) return `${path} should be a finite number`;
  if (schema.enum && !schema.enum.includes(value)) {
    return `${path} should be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} should be ≥ ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} should be ≤ ${schema.maximum}`;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${path} is too long (max ${schema.maxLength} characters)`;
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${path} should have at least ${schema.minItems} items`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${path} should have at most ${schema.maxItems} items`;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateArgs(schema.items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
    }
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) return `${path}.${key} is required`;
    }
    for (const [key, v] of Object.entries(obj)) {
      const prop = schema.properties?.[key];
      if (prop) {
        const err = validateArgs(prop, v, `${path}.${key}`);
        if (err) return err;
      } else if (schema.additionalProperties === false) {
        return `${path}.${key} is not a known argument`;
      } else if (typeof schema.additionalProperties === "object") {
        const err = validateArgs(schema.additionalProperties, v, `${path}.${key}`);
        if (err) return err;
      }
    }
  }
  return null;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" registered twice`);
    this.tools.set(tool.name, tool);
  }

  list(): ToolInfo[] {
    return [...this.tools.values()].map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }));
  }

  /** Validate and run a tool. Throws AutomationError on unknown tool, bad input, or a handler error. */
  async call(name: string, args: unknown = {}): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AutomationError(
        "UNKNOWN_TOOL",
        `No tool "${name}". Available: ${[...this.tools.keys()].join(", ")}.`,
      );
    }
    const a = args ?? {};
    const problem = validateArgs(tool.inputSchema, a);
    if (problem) throw new AutomationError("BAD_INPUT", `${name}: ${problem}.`);
    return tool.handler(a as Record<string, unknown>);
  }

  /** Like call, but returns errors as an `isError` result (what MCP expects). */
  async callSafe(name: string, args: unknown = {}): Promise<ToolResult> {
    try {
      return await this.call(name, args);
    } catch (e) {
      const msg =
        e instanceof AutomationError ? `${e.code}: ${e.message}` : `Unexpected error: ${(e as Error)?.message ?? e}`;
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  }
}
