import { Clock, Effect, FileSystem, Path, Schema } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { agentDetected } from "./agent-mode.ts";

const DOCS_URL =
  "https://supabase.com/docs/guides/local-development/running-multiple-local-projects";

const START_STACK_NUDGE_MESSAGE = `Try the new local stack: faster, lighter, and one project per worktree in parallel.
To switch: remove the fixed ports from supabase/config.toml, then add \`stack = true\` under \`[experimental]\`.
Steps and limitations: ${DOCS_URL}`;

const INIT_STACK_NUDGE_MESSAGE = `Try the new faster, lighter, parallel local stack: SUPABASE_EXPERIMENTAL_STACK=1 supabase init --force (regenerates this config)
Learn more: ${DOCS_URL}`;

const INIT_STACK_ENABLED_MESSAGE =
  "Experimental local stack enabled in supabase/config.toml. Share feedback: https://github.com/supabase/cli/issues";

const NUDGE_STATE_FILE = "stack-nudge.json";
const NUDGE_INTERVAL_MILLIS = 7 * 24 * 60 * 60 * 1000;

const NudgeState = Schema.fromJsonString(Schema.Struct({ lastShownAt: Schema.Finite }));

const START_AGENT_ASK_LINE =
  "Coding agents: offer this switch to the user and ask before changing supabase/config.toml.";
const INIT_AGENT_ASK_LINE =
  "Coding agents: offer this to the user and ask before re-running init with --force.";

/**
 * Who to nudge: a coding agent, a human at a terminal, or nobody. Text mode writes to stderr so
 * piped stdout stays clean; json and stream-json use `output.info` so result payloads are unchanged.
 */
const nudgeAudience = Effect.gen(function* () {
  const output = yield* Output;
  if (yield* agentDetected) return "agent" as const;
  return output.interactive ? ("human" as const) : undefined;
});

const emitNudge = Effect.fnUntraced(function* (message: string) {
  const output = yield* Output;
  if (output.format === "text") return yield* output.raw(`${message}\n`, "stderr");
  return yield* output.info(message);
});

/**
 * Prints the stack nudge on stderr at most once every 7 days. The throttle state is best-effort:
 * any read or write failure is swallowed so it can never fail `start`.
 */
export const maybeShowStartStackNudge = Effect.fn("StackNudge.maybeShowStart")(function* () {
  const audience = yield* nudgeAudience;
  if (audience === undefined) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* CommandSettings;
  const statePath = path.join(settings.supabaseHome, NUDGE_STATE_FILE);
  const now = yield* Clock.currentTimeMillis;

  const lastShownAt = yield* fs.readFileString(statePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NudgeState)),
    Effect.map((state) => state.lastShownAt),
    Effect.orElseSucceed(() => undefined),
  );
  const throttled =
    lastShownAt !== undefined &&
    now - lastShownAt >= 0 &&
    now - lastShownAt < NUDGE_INTERVAL_MILLIS;
  yield* Effect.annotateCurrentSpan({ "stack_nudge.throttled": throttled });
  if (throttled) return;

  yield* emitNudge(
    audience === "agent"
      ? `${START_STACK_NUDGE_MESSAGE}\n${START_AGENT_ASK_LINE}`
      : START_STACK_NUDGE_MESSAGE,
  );
  yield* Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(NudgeState)({ lastShownAt: now });
    yield* fs.makeDirectory(settings.supabaseHome, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(statePath, encoded);
  }).pipe(Effect.ignore);
});

/** Prints the `init` nudge or confirmation on stderr to a human at a terminal or an agent. */
export const showInitStackNote = Effect.fn("StackNudge.showInit")(function* (
  experimentalStack: boolean,
) {
  const audience = yield* nudgeAudience;
  if (audience === undefined) return;
  if (experimentalStack) return yield* emitNudge(INIT_STACK_ENABLED_MESSAGE);
  yield* emitNudge(
    audience === "agent"
      ? `${INIT_STACK_NUDGE_MESSAGE}\n${INIT_AGENT_ASK_LINE}`
      : INIT_STACK_NUDGE_MESSAGE,
  );
});
