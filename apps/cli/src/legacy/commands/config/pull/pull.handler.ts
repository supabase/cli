import { loadProjectConfig, resolveProjectValue } from "@supabase/config";
import { Effect, Option } from "effect";

import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyConfigPullFlags } from "./pull.command.ts";
import {
  LegacyConfigPullFileNotFoundError,
  LegacyConfigPullNetworkError,
  LegacyConfigPullStatusError,
  LegacyConfigPullTargetEmptyError,
  LegacyConfigPullTargetNotFoundError,
} from "./pull.errors.ts";

interface LegacyConfigChange {
  readonly path: string;
  readonly local: unknown;
  readonly remote: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(local: unknown, remote: unknown): boolean {
  return JSON.stringify(local) === JSON.stringify(remote);
}

function diffRemoteConfig(
  local: unknown,
  remote: unknown,
  path: ReadonlyArray<string> = [],
): ReadonlyArray<LegacyConfigChange> {
  if (isRecord(remote)) {
    const localRecord = isRecord(local) ? local : {};
    return Object.entries(remote).flatMap(([key, value]) =>
      diffRemoteConfig(localRecord[key], value, [...path, key]),
    );
  }

  if (sameValue(local, remote)) {
    return [];
  }

  return [{ path: path.join("."), local, remote }];
}

function formatValue(value: unknown): string {
  if (value === undefined) return "<unset>";
  return String(JSON.stringify(value));
}

const fetchRemoteConfig = Effect.fnUntraced(function* (ref: string, target: string) {
  const api = yield* LegacyPlatformApi;
  return yield* api.v1.getProjectConfig({ ref, branch: target }).pipe(
    Effect.catch(
      mapLegacyHttpError({
        networkError: LegacyConfigPullNetworkError,
        statusError: LegacyConfigPullStatusError,
        networkMessage: (cause) => `failed to pull config: ${cause}`,
        statusMessage: (status, body) => `unexpected config pull status ${status}: ${body}`,
      }),
    ),
    Effect.mapError((cause) =>
      cause._tag === "LegacyConfigPullStatusError" && cause.status === 404
        ? new LegacyConfigPullTargetNotFoundError({
            message: `Branch '${target}' not found.`,
            suggestion: "Run `supabase branches list` to see available branches.",
          })
        : cause,
    ),
  );
});

export const legacyConfigPull = Effect.fn("legacy.config.pull")(function* (
  flags: LegacyConfigPullFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const runtimeInfo = yield* RuntimeInfo;

  if (flags.target.length === 0) {
    return yield* new LegacyConfigPullTargetEmptyError({
      message: "--target must not be empty.",
    });
  }

  const ref = yield* resolver.resolve(Option.none());
  yield* Effect.gen(function* () {
    yield* output.intro("Config pull");
    const pulling = yield* output.task(`Pulling config from '${flags.target}'...`);

    const result = yield* Effect.gen(function* () {
      const loaded = yield* loadProjectConfig(runtimeInfo.cwd, {
        projectRef: ref,
        goViperCompat: true,
      });
      if (loaded === null) {
        return yield* new LegacyConfigPullFileNotFoundError({
          message: "No supabase/config.toml or supabase/config.json file was found.",
          suggestion: "Run `supabase init` first.",
        });
      }

      const remote = yield* fetchRemoteConfig(ref, flags.target);
      const local = yield* resolveProjectValue(loaded.config, { values: {} }, "", {
        goViperCompat: true,
      });
      return diffRemoteConfig(local, remote);
    }).pipe(Effect.tapError(() => pulling.fail()));

    yield* pulling.clear();
    const data = { project_ref: ref, target: flags.target, changes: result };
    const goOutput = Option.getOrUndefined(goOutputFlag);
    if (goOutput === "json") {
      yield* output.raw(encodeGoJson(data));
      return;
    }
    if (goOutput === "yaml") {
      yield* output.raw(encodeYaml(data));
      return;
    }
    if (goOutput === "toml") {
      yield* output.raw(`${encodeToml(data)}\n`);
      return;
    }
    if (goOutput === "env") {
      yield* output.raw(`${encodeEnv(data)}\n`);
      return;
    }
    if (output.format !== "text") {
      yield* output.success("Config diff", data);
      return;
    }

    for (const change of result) {
      yield* output.info(
        `${change.path}\n  local:  ${formatValue(change.local)}\n  remote: ${formatValue(change.remote)}`,
      );
    }
    yield* output.outro(
      result.length === 0
        ? `Config matches '${flags.target}'.`
        : `Found ${result.length} config difference${result.length === 1 ? "" : "s"} for '${flags.target}'.`,
    );
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
