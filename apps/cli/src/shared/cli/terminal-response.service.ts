import { Context, Effect, type Cause } from "effect";

export const TerminalResponse = Context.Reference<{
  readonly markAttempt: Effect.Effect<void>;
  readonly reportFailure?: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}>("supabase/TerminalResponse", { defaultValue: () => ({ markAttempt: Effect.void }) });
