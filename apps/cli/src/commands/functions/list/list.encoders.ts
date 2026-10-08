import { encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
  shapeBool,
  shapeInt,
  shapePtr,
  shapeSlice,
  shapeString,
  shapeStruct,
  shapeTomlListWrapper,
} from "../../../command-internal/struct-output.encoders.ts";

/** Struct spec for the function response. */
const FUNCTION_RESPONSE_SHAPE = shapeStruct([
  ["created_at", shapeInt],
  ["entrypoint_path", shapePtr(shapeString)],
  ["ezbr_sha256", shapePtr(shapeString)],
  ["id", shapeString],
  ["import_map", shapePtr(shapeBool)],
  ["import_map_path", shapePtr(shapeString)],
  ["name", shapeString],
  ["slug", shapeString],
  ["status", shapeString],
  ["updated_at", shapeInt],
  ["verify_jwt", shapePtr(shapeBool)],
  ["version", shapeInt],
]);

const FUNCTIONS_LIST_SHAPE = shapeSlice(FUNCTION_RESPONSE_SHAPE);

const FUNCTIONS_TOML_WRAPPER_SHAPE = shapeTomlListWrapper("functions", FUNCTION_RESPONSE_SHAPE);

interface FunctionRecord {
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

export type Functions = ReadonlyArray<FunctionRecord>;
export type ParsedFunctions = {
  readonly functions: Functions;
  readonly isNil: boolean;
};

const INVALID_FIELD = Symbol("invalid function field");
type InvalidField = typeof INVALID_FIELD;
const EMPTY_FUNCTION_RECORD: Record<string, unknown> = {};

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

function readStringField(record: Record<string, unknown>, key: string): string | InvalidField {
  const value = record[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : INVALID_FIELD;
}

function readIntegerField(record: Record<string, unknown>, key: string): number | InvalidField {
  const value = record[key];
  if (value === undefined || value === null) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : INVALID_FIELD;
}

function readRequiredFunctionFields(
  record: Record<string, unknown>,
):
  | Omit<
      FunctionRecord,
      "verify_jwt" | "import_map" | "entrypoint_path" | "import_map_path" | "ezbr_sha256"
    >
  | undefined {
  const id = readStringField(record, "id");
  const slug = readStringField(record, "slug");
  const name = readStringField(record, "name");
  const status = readStringField(record, "status");
  const version = readIntegerField(record, "version");
  const createdAt = readIntegerField(record, "created_at");
  const updatedAt = readIntegerField(record, "updated_at");
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

function optionalJsonFields(function_: Functions[number]) {
  return {
    ...(function_.entrypoint_path != null ? { entrypoint_path: function_.entrypoint_path } : {}),
    ...(function_.ezbr_sha256 != null ? { ezbr_sha256: function_.ezbr_sha256 } : {}),
    ...(function_.import_map != null ? { import_map: function_.import_map } : {}),
    ...(function_.import_map_path != null ? { import_map_path: function_.import_map_path } : {}),
    ...(function_.verify_jwt != null ? { verify_jwt: function_.verify_jwt } : {}),
  };
}

function parseFunctionsResponse(value: unknown): ParsedFunctions | undefined {
  if (value === null) {
    return { functions: [], isNil: true };
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const functions: FunctionRecord[] = [];
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

export function decodeFunctionsResponse(
  rawBody: string,
):
  | { readonly ok: true; readonly value: ParsedFunctions }
  | { readonly ok: false; readonly message: string } {
  try {
    const parsed = parseFunctionsResponse(JSON.parse(rawBody));
    if (parsed === undefined) {
      return {
        ok: false,
        message:
          "failed to list functions: response body did not match the expected function array shape",
      };
    }
    return { ok: true, value: parsed };
  } catch (cause) {
    return {
      ok: false,
      message: `failed to list functions: ${String(cause)}`,
    };
  }
}

export function hasJsonContentType(response: {
  readonly headers: Readonly<Record<string, string>>;
}) {
  return (response.headers["content-type"] ?? "").includes("json");
}

function toJsonFunction(function_: Functions[number]) {
  const base = baseFunctionFields(function_);
  return {
    created_at: base.created_at,
    id: base.id,
    name: base.name,
    slug: base.slug,
    status: base.status,
    updated_at: base.updated_at,
    version: base.version,
    ...optionalJsonFields(function_),
  };
}

export function encodeFunctionsListJson(parsed: ParsedFunctions): string {
  return parsed.isNil
    ? encodeSortedJson(null)
    : encodeSortedJson(parsed.functions.map(toJsonFunction));
}

export function encodeFunctionsListYaml(functions: Functions): string {
  return encodeStructYaml(functions, FUNCTIONS_LIST_SHAPE);
}

export function encodeFunctionsListToml(parsed: ParsedFunctions): string {
  // A JSON `null` body is a nil list (BurntSushi emits nothing), while `[]` is a
  // non-nil empty list (`functions = []`).
  return encodeStructToml(
    { functions: parsed.isNil ? undefined : parsed.functions },
    FUNCTIONS_TOML_WRAPPER_SHAPE,
  );
}
