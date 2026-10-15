import type { Effect, Option } from "effect";
import { Context } from "effect";

/** The machine-readable form of a target, merged into JSON results and error envelopes. */
export type TargetJson = Readonly<Record<string, unknown>>;

/** A target as announced to the user (`text`) and to machine consumers (`json`). */
export interface RenderedTarget {
  readonly text: string;
  readonly json: TargetJson;
}

interface CommandTargetShape {
  /**
   * Prints `Target: <text>` to stderr in every output format, once per distinct `text`. The first
   * announced target also becomes the run's {@link TargetJson}.
   */
  readonly announce: (rendered: RenderedTarget) => Effect.Effect<void>;
  /** The first announced target's JSON form, or `None` before any announcement. */
  readonly json: Effect.Effect<Option.Option<TargetJson>>;
  /** The first announced target's text, or `None` before any announcement. */
  readonly text: Effect.Effect<Option.Option<string>>;
}

/** One cell per command invocation, provided at the root. */
export class CommandTarget extends Context.Service<CommandTarget, CommandTargetShape>()(
  "supabase/output/CommandTarget",
) {}

export const announceTarget = (rendered: RenderedTarget) =>
  CommandTarget.use((cell) => cell.announce(rendered));
