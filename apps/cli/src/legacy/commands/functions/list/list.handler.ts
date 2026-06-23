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
type ParsedFunctions = {
  readonly functions: Functions;
  readonly isNil: boolean;
};

const INVALID_FIELD = Symbol("invalid function field");
type InvalidField = typeof INVALID_FIELD;
const EMPTY_FUNCTION_RECORD: Record<string, unknown> = {};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined | InvalidField {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === "boolean" ? value : INVALID_FIELD;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined | InvalidField {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : INVALID_FIELD;
}

function readOptionalNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined | InvalidField {
  const value = record[key];
  if (value === undefined) return undefined;
  return value === null || typeof value === "string" ? value : INVALID_FIELD;
}

function readGoString(record: Record<string, unknown>, key: string): string | InvalidField {
  const value = record[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : INVALID_FIELD;
}

function readGoInteger(record: Record<string, unknown>, key: string): number | InvalidField {
  const value = record[key];
  if (value === undefined || value === null) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : INVALID_FIELD;
}

function readRequiredFunctionFields(
  record: Record<string, unknown>,
):
  | Omit<
      LegacyFunctionRecord,
      "verify_jwt" | "import_map" | "entrypoint_path" | "import_map_path" | "ezbr_sha256"
    >
  | undefined {
  const id = readGoString(record, "id");
  const slug = readGoString(record, "slug");
  const name = readGoString(record, "name");
  const status = readGoString(record, "status");
  const version = readGoInteger(record, "version");
  const createdAt = readGoInteger(record, "created_at");
  const updatedAt = readGoInteger(record, "updated_at");
  if (
    id === INVALID_FIELD ||
    slug === INVALID_FIELD ||
    name === INVALID_FIELD ||
    status === INVALID_FIELD ||
    version === INVALID_FIELD ||
    createdAt === INVALID_FIELD ||
    updatedAt === INVALID_FIELD
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

function parseFunctionsResponse(value: unknown): ParsedFunctions | undefined {
  if (value === null) {
    return { functions: [], isNil: true };
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const functions: LegacyFunctionRecord[] = [];
  for (const item of value) {
    const record = item === null ? EMPTY_FUNCTION_RECORD : isRecord(item) ? item : undefined;
    if (record === undefined) {
      return undefined;
    }
    const required = readRequiredFunctionFields(record);
    if (required === undefined) {
      return undefined;
    }
    const verifyJwt = readOptionalBoolean(record, "verify_jwt");
    const importMap = readOptionalBoolean(record, "import_map");
    const entrypointPath = readOptionalString(record, "entrypoint_path");
    const importMapPath = readOptionalNullableString(record, "import_map_path");
    const ezbrSha256 = readOptionalString(record, "ezbr_sha256");
    if (
      verifyJwt === INVALID_FIELD ||
      importMap === INVALID_FIELD ||
      entrypointPath === INVALID_FIELD ||
      importMapPath === INVALID_FIELD ||
      ezbrSha256 === INVALID_FIELD
    ) {
      return undefined;
    }
    functions.push({
      ...required,
      verify_jwt: verifyJwt,
      import_map: importMap,
      entrypoint_path: entrypointPath,
      import_map_path: importMapPath,
      ezbr_sha256: ezbrSha256,
    });
  }
  return { functions, isNil: false };
}

function decodeFunctionsResponse(
  rawBody: string,
): Effect.Effect<ParsedFunctions, LegacyFunctionsListNetworkError> {
  return Effect.gen(function* () {
    const parse = (): unknown => JSON.parse(rawBody);
    const parsed = yield* Effect.try({
      try: parse,
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
  return text
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function hasJsonContentType(response: { readonly headers: Readonly<Record<string, string>> }) {
  return (response.headers["content-type"] ?? "").includes("json");
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
  let resolvedProjectRef = Option.none<string>();

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef).pipe(
      Effect.tap((projectRef) =>
        Effect.sync(() => {
          resolvedProjectRef = Option.some(projectRef);
        }),
      ),
    );

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
    if (!hasJsonContentType(response)) {
      const body = sanitizeLegacyErrorBody(rawBody);
      yield* fetching?.fail() ?? Effect.void;
      return yield* new LegacyFunctionsListUnexpectedStatusError({
        status: response.status,
        body,
        message: `unexpected list functions status ${response.status}: ${body}`,
      });
    }
    const parsedFunctions = yield* decodeFunctionsResponse(rawBody).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
    );
    yield* fetching?.clear() ?? Effect.void;
    const { functions, isNil } = parsedFunctions;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new LegacyFunctionsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(
        escapeGoJsonHtmlChars(
          isNil ? encodeGoJson(null) : encodeGoJson(functions.map(toGoJsonFunction)),
        ),
      );
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(functions.map(toGoYamlFunction)));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml({ functions: functions.map(toGoTomlFunction) }));
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
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        Option.match(resolvedProjectRef, {
          onNone: () => Effect.void,
          onSome: (ref) => linkedProjectCache.cache(ref),
        }),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
