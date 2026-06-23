import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";

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

export type Functions = ReadonlyArray<LegacyFunctionRecord>;
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

function escapeGoJsonHtmlChars(text: string): string {
  return text
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function hasJsonContentType(response: {
  readonly headers: Readonly<Record<string, string>>;
}) {
  return (response.headers["content-type"] ?? "").includes("json");
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

export function encodeFunctionsGoJson(parsed: ParsedFunctions): string {
  return escapeGoJsonHtmlChars(
    parsed.isNil ? encodeGoJson(null) : encodeGoJson(parsed.functions.map(toGoJsonFunction)),
  );
}

export function encodeFunctionsGoYaml(functions: Functions): string {
  return encodeYaml(functions.map(toGoYamlFunction));
}

export function encodeFunctionsGoToml(functions: Functions): string {
  return encodeToml({ functions: functions.map(toGoTomlFunction) });
}
