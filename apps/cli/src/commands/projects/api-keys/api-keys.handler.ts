import type { V1GetProjectApiKeysOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { apiKeysToEnv } from "../../../command-internal/api-keys.format.ts";
import { getProjectApiKeys } from "../../../command-internal/get-api-keys.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
} from "../../../command-internal/go-output.encoders.ts";
import {
  encodeGoYaml,
  goAny,
  goMap,
  goNullable,
  goSlice,
  goString,
  goStruct,
  goTime,
} from "../../../command-internal/go-struct-output.encoders.ts";
import { renderProjectApiKeysTable } from "../projects.format.ts";
import type { ProjectsApiKeysFlags } from "./api-keys.command.ts";

type ApiKeys = typeof V1GetProjectApiKeysOutput.Type;

/**
 * Struct spec for the raw API key response. Only `-o yaml` hits the raw
 * struct — `-o toml`/`-o env` encode the `SUPABASE_<NAME>_KEY` env map
 * instead — and yaml.v3 renders the `nullable.Nullable[T]` fields as
 * `map[bool]T`.
 */
const GO_API_KEYS_LIST = goSlice(
  goStruct([
    ["api_key", goNullable(goString)],
    ["description", goNullable(goString)],
    ["hash", goNullable(goString)],
    ["id", goNullable(goString)],
    ["inserted_at", goNullable(goTime)],
    ["name", goString],
    ["prefix", goNullable(goString)],
    ["secret_jwt_template", goNullable(goMap(goAny))],
    ["type", goNullable(goString)],
    ["updated_at", goNullable(goTime)],
  ]),
);

export const projectsApiKeys = Effect.fn("projects.api-keys")(function* (
  flags: ProjectsApiKeysFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // `--project-ref` resolution prompts on a TTY and fails when unlinked.
  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching API keys...") : undefined;
    const keys: ApiKeys = yield* getProjectApiKeys(ref, flags.reveal).pipe(
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
      yield* output.raw(encodeGoYaml(keys, GO_API_KEYS_LIST));
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { keys });
      return;
    }

    yield* output.raw(renderProjectApiKeysTable(keys));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
