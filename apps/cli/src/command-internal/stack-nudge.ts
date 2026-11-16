import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { AiTool } from "../shared/telemetry/ai-tool.service.ts";
import { resolveAgentMode } from "./agent-mode.ts";
import { AgentFlag } from "./global-flags.ts";

const DOCS_URL =
  "https://supabase.com/docs/guides/local-development/running-multiple-local-projects";

export const START_STACK_NUDGE_MESSAGE = `Try the new local stack: faster, lighter, and one project per worktree in parallel.
To switch: remove the fixed ports from supabase/config.toml, then add \`stack = true\` under \`[experimental]\`.
Steps and limitations: ${DOCS_URL}`;

export const INIT_STACK_NUDGE_MESSAGE = `Try the new faster, lighter, parallel local stack: SUPABASE_EXPERIMENTAL_STACK=1 supabase init
Learn more: ${DOCS_URL}`;

export const INIT_STACK_ENABLED_MESSAGE =
  "Experimental local stack enabled in supabase/config.toml. Share feedback: https://github.com/supabase/cli/issues";

const NUDGE_STATE_FILE = "stack-nudge.json";
const NUDGE_INTERVAL_MILLIS = 7 * 24 * 60 * 60 * 1000;

const NudgeState = Schema.fromJsonString(Schema.Struct({ lastShownAt: Schema.Finite }));

const START_AGENT_ASK_LINE =
  "Coding agents: offer this switch to the user and ask before changing supabase/config.toml.";
const INIT_AGENT_ASK_LINE =
  "Coding agents: offer this to the user and ask before re-running init with the new stack.";

/**
 * Who to nudge: a coding agent, a human at a terminal, or nobody. The nudge goes through
 * `output.info`, so every output format renders it on its own log channel and result payloads
 * stay unchanged.
 */
export const nudgeAudience = Effect.gen(function* () {
  const output = yield* Output;
  const agentFlag = Option.getOrElse(yield* Effect.serviceOption(AgentFlag), () => "auto" as const);
  const tool = yield* Effect.serviceOption(AiTool);
  if (
    resolveAgentMode(
      agentFlag,
      Option.flatMap(tool, (detected) => detected.name),
    )
  ) {
    return "agent" as const;
  }
  return output.interactive ? ("human" as const) : undefined;
});

/**
 * Prints the stack nudge on stderr at most once every 7 days. The throttle state is best-effort:
 * any read or write failure is swallowed so it can never fail `start`.
 */
export const maybeShowStartStackNudge = Effect.fn("StackNudge.maybeShowStart")(function* () {
  const audience = yield* nudgeAudience;
  if (audience === undefined) return;
  const output = yield* Output;
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
  const throttled = lastShownAt !== undefined && now - lastShownAt < NUDGE_INTERVAL_MILLIS;
  yield* Effect.annotateCurrentSpan({ "stack_nudge.throttled": throttled });
  if (throttled) return;

  yield* output.info(
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
  const output = yield* Output;
  if (experimentalStack) return yield* output.info(INIT_STACK_ENABLED_MESSAGE);
  yield* output.info(
    audience === "agent"
      ? `${INIT_STACK_NUDGE_MESSAGE}\n${INIT_AGENT_ASK_LINE}`
      : INIT_STACK_NUDGE_MESSAGE,
  );
});
