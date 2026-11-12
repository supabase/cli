import { Context, Effect, Option, Schema } from "effect";

const LocalTargetJson = Schema.Struct({
  kind: Schema.Literal("local"),
  host: Schema.String,
  port: Schema.Finite,
});

const DbUrlTargetJson = Schema.Struct({
  kind: Schema.Literal("db-url"),
  host: Schema.String,
  port: Schema.Finite,
});

const LinkedTargetJson = Schema.Struct({
  kind: Schema.Literal("linked"),
  project_ref: Schema.String,
  project_name: Schema.optionalKey(Schema.String),
  environment: Schema.Literals(["production", "branch", "unverified"]),
  parent_project_ref: Schema.optionalKey(Schema.String),
});

/** The target as merged into JSON results and error envelopes; see `docs/command-target.md`. */
export const CommandTargetJson = Schema.Union([
  LocalTargetJson,
  DbUrlTargetJson,
  LinkedTargetJson,
]).pipe(Schema.toTaggedUnion("kind"));
export type CommandTargetJson = typeof CommandTargetJson.Type;

/** A target as announced to the user (`text`) and to machine consumers (`json`). */
export interface RenderedTarget {
  readonly text: string;
  readonly json: CommandTargetJson;
}

interface CommandTargetShape {
  /**
   * Prints `Target: <text>` to stderr in every output format, once per distinct `text`. The first
   * announced target also becomes the run's {@link CommandTargetJson}.
   */
  readonly announce: (rendered: RenderedTarget) => Effect.Effect<void>;
  /** Appends `hint` to the banner of a local target announced later in this run. */
  readonly hintLocal: (hint: string) => Effect.Effect<void>;
  /** The first announced target's JSON form, or `None` before any announcement. */
  readonly json: Effect.Effect<Option.Option<CommandTargetJson>>;
  /** The first announced target's text, or `None` before any announcement. */
  readonly text: Effect.Effect<Option.Option<string>>;
}

/** One cell per command invocation, provided at the root. */
export class CommandTarget extends Context.Service<CommandTarget, CommandTargetShape>()(
  "supabase/output/CommandTarget",
) {}

export const announceTarget = (rendered: RenderedTarget) =>
  CommandTarget.use((cell) => cell.announce(rendered));

/** Adds the announced target to a plain-object result; arrays, scalars and an own `target` stay. */
export const withCommandTarget = Effect.fnUntraced(function* (data: unknown) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
  const prototype = Object.getPrototypeOf(data);
  if (prototype !== Object.prototype && prototype !== null) return data;
  if ("target" in data && data.target !== undefined) return data;
  const cell = yield* Effect.serviceOption(CommandTarget);
  if (Option.isNone(cell)) return data;
  const target = yield* cell.value.json;
  return Option.isSome(target) ? { ...data, target: target.value } : data;
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Adds the announced target's identity fields to the payload's `target`; the payload's own win. */
export const withAnnouncedTarget = Effect.fnUntraced(function* (
  payload: Readonly<Record<string, unknown>>,
) {
  const announced = yield* CommandTarget.use((cell) => cell.json);
  if (Option.isNone(announced)) return payload;
  const own = isRecord(payload["target"]) ? payload["target"] : {};
  return { ...payload, target: { ...announced.value, ...own } };
});
