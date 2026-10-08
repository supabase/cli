import { describe, expect, it } from "vitest";

import {
  decodeFunctionsResponse,
  encodeFunctionsListJson,
  encodeFunctionsListToml,
  encodeFunctionsListYaml,
  type ParsedFunctions,
} from "./list.encoders.ts";

const SAMPLE_FUNCTION = {
  id: "11111111-2222-3333-4444-555555555555",
  slug: "hello-world",
  name: "Hello World",
  status: "ACTIVE",
  version: 2,
  created_at: 1_687_423_025_152,
  updated_at: 1_687_423_025_152,
  verify_jwt: true,
  import_map: false,
  entrypoint_path: "functions/hello-world/index.ts",
  import_map_path: null,
};

describe("list encoders", () => {
  it("preserves top-level null as a nil function list", () => {
    expect(decodeFunctionsResponse("null")).toEqual({
      ok: true,
      value: { functions: [], isNil: true },
    });
  });

  it("preserves null elements as zero-value rows", () => {
    const decoded = decodeFunctionsResponse("[null]");
    expect(decoded).toEqual({
      ok: true,
      value: {
        functions: [
          {
            id: "",
            slug: "",
            name: "",
            status: "",
            version: 0,
            created_at: 0,
            updated_at: 0,
            verify_jwt: undefined,
            import_map: undefined,
            entrypoint_path: undefined,
            import_map_path: undefined,
            ezbr_sha256: undefined,
          },
        ],
        isNil: false,
      },
    });
  });

  it("preserves zero values for omitted non-pointer fields", () => {
    const decoded = decodeFunctionsResponse("[{}]");
    expect(decoded).toEqual({
      ok: true,
      value: {
        functions: [
          {
            id: "",
            slug: "",
            name: "",
            status: "",
            version: 0,
            created_at: 0,
            updated_at: 0,
            verify_jwt: undefined,
            import_map: undefined,
            entrypoint_path: undefined,
            import_map_path: undefined,
            ezbr_sha256: undefined,
          },
        ],
        isNil: false,
      },
    });
  });

  it("omits null optional fields from JSON output", () => {
    const parsed: ParsedFunctions = {
      functions: [SAMPLE_FUNCTION],
      isNil: false,
    };
    expect(encodeFunctionsListJson(parsed)).not.toContain('"import_map_path": null');
  });

  it("escapes html-sensitive and line-separator characters in JSON output", () => {
    const parsed: ParsedFunctions = {
      functions: [
        {
          ...SAMPLE_FUNCTION,
          name: "<Hello>&World>\u2028\u2029",
        },
      ],
      isNil: false,
    };
    expect(encodeFunctionsListJson(parsed)).toContain(
      '"name": "\\u003cHello\\u003e\\u0026World\\u003e\\u2028\\u2029"',
    );
  });

  it("keeps JSON keys in the legacy order", () => {
    const parsed: ParsedFunctions = {
      functions: [SAMPLE_FUNCTION],
      isNil: false,
    };
    expect(encodeFunctionsListJson(parsed)).toContain(`{
    "created_at": 1687423025152,
    "entrypoint_path": "functions/hello-world/index.ts",
    "id": "11111111-2222-3333-4444-555555555555",
    "import_map": false,
    "name": "Hello World",
    "slug": "hello-world",
    "status": "ACTIVE",
    "updated_at": 1687423025152,
    "verify_jwt": true,
    "version": 2
  }`);
  });

  it("keeps YAML keys and null optional fields", () => {
    expect(
      encodeFunctionsListYaml([
        { ...SAMPLE_FUNCTION, verify_jwt: undefined, import_map: undefined },
      ]),
    ).toContain(`- createdat: 1687423025152
  entrypointpath: functions/hello-world/index.ts
  ezbrsha256: null
  id: 11111111-2222-3333-4444-555555555555
  importmap: null
  importmappath: null`);
  });

  it("keeps TOML keys in struct order with BurntSushi's 2-space indentation", () => {
    expect(encodeFunctionsListToml({ functions: [SAMPLE_FUNCTION], isNil: false })).toBe(
      `[[functions]]
  CreatedAt = 1687423025152
  EntrypointPath = "functions/hello-world/index.ts"
  Id = "11111111-2222-3333-4444-555555555555"
  ImportMap = false
  Name = "Hello World"
  Slug = "hello-world"
  Status = "ACTIVE"
  UpdatedAt = 1687423025152
  VerifyJwt = true
  Version = 2
`,
    );
  });

  it("emits nothing for a nil TOML list and `functions = []` for a decoded empty list", () => {
    expect(encodeFunctionsListToml({ functions: [], isNil: true })).toBe("");
    expect(encodeFunctionsListToml({ functions: [], isNil: false })).toBe("functions = []\n");
  });
});
