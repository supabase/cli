import { operationDefinitions } from "@supabase/api/effect";
import { Data, Effect, Option } from "effect";

import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError, sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyFunctionsListFlags } from "./list.command.ts";

interface LegacyFunctionRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly verify_jwt?: boolean;
  readonly import_map?: boolean;
  readonly entrypoint_path?: string;
  readonly import_map_path?: string | null;
  readonly ezbr_sha256?: string;
}

type Functions = ReadonlyArray<LegacyFunctionRecord>;

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

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  return value === null || typeof value === "string" ? value : undefined;
}

function readRequiredString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRequiredNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readRequiredFunctionFields(
  record: Record<string, unknown>,
):
  | Omit<
      LegacyFunctionRecord,
      "verify_jwt" | "import_map" | "entrypoint_path" | "import_map_path" | "ezbr_sha256"
    >
  | undefined {
  const id = readRequiredString(record, "id");
  const slug = readRequiredString(record, "slug");
  const name = readRequiredString(record, "name");
  const status = readRequiredString(record, "status");
  const version = readRequiredNumber(record, "version");
  const createdAt = readRequiredNumber(record, "created_at");
  const updatedAt = readRequiredNumber(record, "updated_at");
  if (
    id === undefined ||
    slug === undefined ||
    name === undefined ||
    status === undefined ||
    version === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }
  return {
    id,
    slug,
    name,
    status,
    version,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parseFunctionsResponse(value: unknown): Functions | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const functions: LegacyFunctionRecord[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const required = readRequiredFunctionFields(record);
    if (required === undefined) {
      return undefined;
    }
    functions.push({
      ...required,
      verify_jwt: readOptionalBoolean(record, "verify_jwt"),
      import_map: readOptionalBoolean(record, "import_map"),
      entrypoint_path: readOptionalString(record, "entrypoint_path"),
      import_map_path: readOptionalNullableString(record, "import_map_path"),
      ezbr_sha256: readOptionalString(record, "ezbr_sha256"),
    });
  }
  return functions;
}

function decodeFunctionsResponse(
  rawBody: string,
): Effect.Effect<Functions, LegacyFunctionsListNetworkError> {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(rawBody) as unknown,
      catch: (cause) =>
        new LegacyFunctionsListNetworkError({
          message: `failed to list functions: ${String(cause)}`,
        }),
    });
    const functions = parseFunctionsResponse(parsed);
    if (functions === undefined) {
      return yield* new LegacyFunctionsListNetworkError({
        message:
          "failed to list functions: response body did not match the expected function array shape",
      });
    }
    return functions;
  });
}

function escapeGoJsonHtmlChars(text: string): string {
  return text.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function baseFunctionFields(function_: Functions[number]) {
  return {
    id: function_.id,
    name: function_.name,
    slug: function_.slug,
    status: function_.status,
    version: function_.version,
    created_at: function_.created_at,
    updated_at: function_.updated_at,
  };
}

function optionalGoJsonFields(function_: Functions[number]) {
  return {
    ...(function_.entrypoint_path != null ? { entrypoint_path: function_.entrypoint_path } : {}),
    ...(function_.ezbr_sha256 != null ? { ezbr_sha256: function_.ezbr_sha256 } : {}),
    ...(function_.import_map != null ? { import_map: function_.import_map } : {}),
    ...(function_.import_map_path != null ? { import_map_path: function_.import_map_path } : {}),
    ...(function_.verify_jwt != null ? { verify_jwt: function_.verify_jwt } : {}),
  };
}

function toGoYamlFunction(function_: Functions[number]) {
  const base = baseFunctionFields(function_);
  return {
    createdat: base.created_at,
    entrypointpath: function_.entrypoint_path ?? null,
    ezbrsha256: function_.ezbr_sha256 ?? null,
    id: base.id,
    importmap: function_.import_map ?? null,
    importmappath: function_.import_map_path ?? null,
    name: base.name,
    slug: base.slug,
    status: base.status,
    updatedat: base.updated_at,
    verifyjwt: function_.verify_jwt ?? null,
    version: base.version,
  };
}

function toGoJsonFunction(function_: Functions[number]) {
  const base = baseFunctionFields(function_);
  return {
    created_at: base.created_at,
    id: base.id,
    name: base.name,
    slug: base.slug,
    status: base.status,
    updated_at: base.updated_at,
    version: base.version,
    ...optionalGoJsonFields(function_),
  };
}

function toGoTomlFunction(function_: Functions[number]) {
  const base = baseFunctionFields(function_);
  return {
    CreatedAt: base.created_at,
    ...(function_.entrypoint_path != null ? { EntrypointPath: function_.entrypoint_path } : {}),
    ...(function_.ezbr_sha256 != null ? { EzbrSha256: function_.ezbr_sha256 } : {}),
    Id: base.id,
    ...(function_.import_map != null ? { ImportMap: function_.import_map } : {}),
    ...(function_.import_map_path != null ? { ImportMapPath: function_.import_map_path } : {}),
    Name: base.name,
    Slug: base.slug,
    Status: base.status,
    UpdatedAt: base.updated_at,
    ...(function_.verify_jwt != null ? { VerifyJwt: function_.verify_jwt } : {}),
    Version: base.version,
  };
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
    const response = yield* api.executeRaw(operationDefinitions.v1ListAllFunctions, { ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    if (response.status !== 200) {
      const body = sanitizeLegacyErrorBody(
        yield* response.text.pipe(Effect.orElseSucceed(() => "")),
      );
      yield* fetching?.fail() ?? Effect.void;
      return yield* new LegacyFunctionsListUnexpectedStatusError({
        status: response.status,
        body,
        message: `unexpected list functions status ${response.status}: ${body}`,
      });
    }
    const rawBody = yield* response.text.pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(
        (cause) =>
          new LegacyFunctionsListNetworkError({ message: `failed to list functions: ${cause}` }),
      ),
    );
    const functions = yield* decodeFunctionsResponse(rawBody).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
    );
    yield* fetching?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new LegacyFunctionsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(escapeGoJsonHtmlChars(encodeGoJson(functions.map(toGoJsonFunction))));
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
    if (goFmt === "pretty") {
      yield* output.raw(renderFunctionsTable(functions));
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { functions });
      return;
    }

    yield* output.raw(renderFunctionsTable(functions));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
