import { Context, Effect, Option, Schema } from "effect";

const LocalTargetJson = Schema.Struct({
  kind: Schema.Literal("local"),
  host: Schema.String,
  port: Schema.Number,
});

const DbUrlTargetJson = Schema.Struct({
  kind: Schema.Literal("db-url"),
  host: Schema.String,
  port: Schema.Number,
});

const LinkedTargetJson = Schema.Struct({
  kind: Schema.Literal("linked"),
  project_ref: Schema.String,
  project_name: Schema.optionalKey(Schema.String),
  environment: Schema.Literals(["production", "branch", "unverified"]),
  parent_project_ref: Schema.optionalKey(Schema.String),
});

/** The machine-readable form of a target, merged into JSON results and error envelopes as `target`. See `apps/cli/docs/command-target.md`. */
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Adds the announced target's identity fields in front of the payload's own `target` fields, which win on a clash. */
export const withAnnouncedTarget = Effect.fnUntraced(function* (
  payload: Readonly<Record<string, unknown>>,
) {
  const announced = yield* CommandTarget.use((cell) => cell.json);
  if (Option.isNone(announced)) return payload;
  const own = isRecord(payload["target"]) ? payload["target"] : {};
  return { ...payload, target: { ...announced.value, ...own } };
});
