import { Context, Effect } from "effect";

export const TerminalResponse = Context.Reference<{
  readonly markAttempt: Effect.Effect<void>;
  readonly markWriterDefect: Effect.Effect<void>;
}>("supabase/TerminalResponse", {
  defaultValue: () => ({ markAttempt: Effect.void, markWriterDefect: Effect.void }),
});
