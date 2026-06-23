import type { V1GetProjectApiKeysOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { apiKeysToEnv } from "../../../shared/legacy-api-keys.format.ts";
import { legacyGetProjectApiKeys } from "../../../shared/legacy-get-api-keys.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { renderProjectApiKeysTable } from "../projects.format.ts";
import type { LegacyProjectsApiKeysFlags } from "./api-keys.command.ts";

type ApiKeys = typeof V1GetProjectApiKeysOutput.Type;

export const legacyProjectsApiKeys = Effect.fn("legacy.projects.api-keys")(function* (
  flags: LegacyProjectsApiKeysFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // Go's root PersistentPreRun resolves `--project-ref` via `ParseProjectRef`
  // (`root.go:112-115`), which prompts on a TTY and fails when unlinked.
  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching API keys...") : undefined;
    const keys: ApiKeys = yield* legacyGetProjectApiKeys(ref, flags.reveal).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
    );
    yield* fetching?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    // Go encodes the `SUPABASE_<NAME>_KEY` env map for both toml and env
    // (`api_keys.go:34-36`).
    if (goFmt === "toml") {
      yield* output.raw(encodeToml(apiKeysToEnv(keys)) + "\n");
      return;
    }
    if (goFmt === "env") {
      yield* output.raw(encodeEnv(apiKeysToEnv(keys)) + "\n");
      return;
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(keys));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(keys));
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { keys });
      return;
    }

    yield* output.raw(renderProjectApiKeysTable(keys));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
