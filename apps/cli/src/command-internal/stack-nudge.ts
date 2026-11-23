import { Clock, Effect, FileSystem, Path, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { CommandSettings } from "../config/command-settings.service.ts";
import { resolveExperimentalFeature } from "../shared/config/experimental-feature.ts";
import { Output } from "../shared/output/output.service.ts";
import { agentDetected } from "./agent-mode.ts";
import { type ConfigFileRef, configSetting } from "./config-advice.ts";

const DOCS_URL =
  "https://supabase.com/docs/guides/local-development/running-multiple-local-projects";

const startStackNudgeMessage = (configFile: ConfigFileRef): string =>
  `Try the new local stack: faster, lighter, and one project per worktree in parallel.
To switch: run \`supabase stop\`, remove the fixed ports from ${configFile.path}, then set ${configSetting(configFile.format, "experimental", "stack", "true")}.
Steps and limitations: ${DOCS_URL}`;

const INIT_STACK_NUDGE_MESSAGE = `Try the new faster, lighter, parallel local stack: set SUPABASE_EXPERIMENTAL_STACK=1 before your next \`supabase init\`.
To switch this project: ${DOCS_URL}`;

const INIT_STACK_ENABLED_MESSAGE =
  "Experimental local stack enabled in supabase/config.toml. Share feedback: https://github.com/supabase/cli/issues";

const NUDGE_STATE_FILE = "stack-nudge.json";
const NUDGE_INTERVAL_MILLIS = 7 * 24 * 60 * 60 * 1000;

const NudgeState = Schema.fromJsonString(Schema.Struct({ lastShownAt: Schema.Finite }));

const startAgentAskLine = (configFile: ConfigFileRef): string =>
  `Coding agents: offer this switch to the user and ask before changing ${configFile.path}.`;
const INIT_AGENT_ASK_LINE =
  "Coding agents: offer this to the user and ask before changing supabase/config.toml.";

/** Who to nudge: a coding agent, a human at a terminal, or nobody. */
const nudgeAudience = Effect.gen(function* () {
  const output = yield* Output;
  // With the config side pinned to true, only an explicit shell `SUPABASE_EXPERIMENTAL_STACK=0`
  // resolves to false; that user opted out, so the nudge stays quiet.
  const optedOut = !(yield* resolveExperimentalFeature({
    feature: "stack",
    configValue: Effect.succeed(true),
  }).pipe(Effect.orElseSucceed(() => true)));
  if (optedOut) return undefined;
  if (yield* agentDetected) return "agent" as const;
  return output.interactive ? ("human" as const) : undefined;
});

/** Text mode writes to stderr so piped stdout stays clean; other formats use `output.info`. */
const emitNudge = Effect.fnUntraced(function* (message: string) {
  const output = yield* Output;
  if (output.format === "text") return yield* output.raw(`${message}\n`, "stderr");
  return yield* output.info(message);
});

/**
 * Shows the stack nudge at most once every 7 days. The throttle state is best-effort: any read or
 * write failure is swallowed so it can never fail `start`.
 */
export const maybeShowStartStackNudge = Effect.fn("StackNudge.maybeShowStart")(function* (
  configFile: ConfigFileRef,
) {
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
      ? `${startStackNudgeMessage(configFile)}\n${startAgentAskLine(configFile)}`
      : startStackNudgeMessage(configFile),
  );
  // Write-then-rename so a symlink planted at the state path is replaced, never followed.
  const tmpPath = `${statePath}.tmp.${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`;
  yield* Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(NudgeState)({ lastShownAt: now });
    yield* fs.makeDirectory(settings.supabaseHome, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(tmpPath, encoded, { mode: 0o600 });
    yield* fs.rename(tmpPath, statePath);
  }).pipe(Effect.ensuring(fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)), Effect.ignore);
});

/** Shows the `init` nudge or confirmation to a human at a terminal or an agent. */
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
