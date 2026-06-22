import type { V1ListAllFunctionsOutput } from "@supabase/api/effect";
import { Data, Effect, Option } from "effect";

import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyFunctionsListFlags } from "./list.command.ts";

type Functions = typeof V1ListAllFunctionsOutput.Type;

class LegacyFunctionsListNetworkError extends Data.TaggedError("LegacyFunctionsListNetworkError")<{
  readonly message: string;
}> {}

class LegacyFunctionsListUnexpectedStatusError extends Data.TaggedError(
  "LegacyFunctionsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

class LegacyFunctionsEnvNotSupportedError extends Data.TaggedError(
  "LegacyFunctionsEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

const mapListError = mapLegacyHttpError({
  networkError: LegacyFunctionsListNetworkError,
  statusError: LegacyFunctionsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list functions: ${cause}`,
  statusMessage: (status, body) => `unexpected list functions status ${status}: ${body}`,
});

function formatUnixMilliTimestamp(value: number): string {
  const date = new Date(value);
  const parts = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  const [year, ...rest] = parts.map((part) => part.toString().padStart(2, "0"));
  return `${year}-${rest[0]}-${rest[1]} ${rest[2]}:${rest[3]}:${rest[4]}`;
}

function renderFunctionsTable(functions: Functions): string {
  return renderGlamourTable(
    ["ID", "NAME", "SLUG", "STATUS", "VERSION", "UPDATED_AT (UTC)"],
    functions.map((fn) => [
      fn.id,
      fn.name,
      fn.slug,
      fn.status,
      String(fn.version),
      formatUnixMilliTimestamp(fn.updated_at),
    ]),
  );
}

function toGoYamlFunction(function_: Functions[number]) {
  return {
    createdat: function_.created_at,
    entrypointpath: function_.entrypoint_path,
    ezbrsha256: function_.ezbr_sha256 ?? null,
    id: function_.id,
    importmap: function_.import_map,
    importmappath: function_.import_map_path,
    name: function_.name,
    slug: function_.slug,
    status: function_.status,
    updatedat: function_.updated_at,
    verifyjwt: function_.verify_jwt,
    version: function_.version,
  };
}

function toGoTomlFunction(function_: Functions[number]) {
  const goFunction: Record<string, unknown> = {
    CreatedAt: function_.created_at,
    Id: function_.id,
    Name: function_.name,
    Slug: function_.slug,
    Status: function_.status,
    UpdatedAt: function_.updated_at,
    Version: function_.version,
  };
  if (function_.entrypoint_path != null) {
    goFunction.EntrypointPath = function_.entrypoint_path;
  }
  if (function_.ezbr_sha256 != null) {
    goFunction.EzbrSha256 = function_.ezbr_sha256;
  }
  if (function_.import_map != null) {
    goFunction.ImportMap = function_.import_map;
  }
  if (function_.import_map_path != null) {
    goFunction.ImportMapPath = function_.import_map_path;
  }
  if (function_.verify_jwt != null) {
    goFunction.VerifyJwt = function_.verify_jwt;
  }
  return goFunction;
}

export const legacyFunctionsList = Effect.fn("legacy.functions.list")(function* (
  flags: LegacyFunctionsListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching functions...") : undefined;
    const functions: Functions = yield* api.v1.listAllFunctions({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    yield* fetching?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new LegacyFunctionsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(functions));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(functions.map(toGoYamlFunction)));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml({ functions: functions.map(toGoTomlFunction) }) + "\n");
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { functions });
      return;
    }

    yield* output.raw(renderFunctionsTable(functions));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
