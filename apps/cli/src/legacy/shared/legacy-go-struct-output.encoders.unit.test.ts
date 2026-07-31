import { describe, expect, it } from "vitest";

import {
  LegacyGoTomlEncodeError,
  encodeLegacyGoToml,
  encodeLegacyGoYaml,
  legacyGoAny,
  legacyGoBool,
  legacyGoFieldName,
  legacyGoFloat32,
  legacyGoFloat64,
  legacyGoFormatFloat,
  legacyGoInt,
  legacyGoMap,
  legacyGoNullable,
  legacyGoPtr,
  legacyGoSlice,
  legacyGoString,
  legacyGoStruct,
  legacyGoTime,
  legacyGoTomlListWrapper,
  legacyGoUuid,
} from "./legacy-go-struct-output.encoders.ts";

/**
 * Every golden byte string in this file was captured from a scratch Go
 * program calling the Go CLI's own `utils.EncodeOutput`
 * (`apps/cli-go/internal/utils/output.go`) with BurntSushi toml v1.6.0 and
 * yaml.v3 v3.0.1 — the exact library versions pinned in `apps/cli-go/go.mod`.
 */

// Mirror of `api.BranchResponse` (apps/cli-go/pkg/api/types.gen.go).
const BRANCH_RESPONSE = legacyGoStruct([
  ["created_at", legacyGoTime],
  ["deletion_scheduled_at", legacyGoPtr(legacyGoTime)],
  ["git_branch", legacyGoPtr(legacyGoString)],
  ["id", legacyGoUuid],
  ["is_default", legacyGoBool],
  ["latest_check_run_id", legacyGoPtr(legacyGoFloat32)],
  ["name", legacyGoString],
  ["notify_url", legacyGoPtr(legacyGoString)],
  ["parent_project_ref", legacyGoString],
  ["persistent", legacyGoBool],
  ["pr_number", legacyGoPtr(legacyGoInt)],
  ["preview_project_status", legacyGoPtr(legacyGoString)],
  ["project_ref", legacyGoString],
  ["review_requested_at", legacyGoPtr(legacyGoTime)],
  ["status", legacyGoString],
  ["updated_at", legacyGoTime],
  ["with_data", legacyGoBool],
]);

const SAMPLE_BRANCH = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "feat-1",
  project_ref: "aaaaaaaaaaaaaaaaaaaa",
  parent_project_ref: "bbbbbbbbbbbbbbbbbbbb",
  is_default: false,
  git_branch: "feat-1",
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: true,
};

// All pointer fields absent — Go zero-fills the value fields.
const ZERO_BRANCH = {
  name: "Production",
  is_default: true,
  parent_project_ref: "production-project-ref",
  project_ref: "production-project-ref",
  status: "FUNCTIONS_DEPLOYED",
};

describe("encodeLegacyGoToml", () => {
  it("matches Go byte-for-byte for a branches list wrapper (PascalCase, nil pointers omitted, native datetimes)", () => {
    const wrapper = legacyGoTomlListWrapper("branches", BRANCH_RESPONSE);
    expect(encodeLegacyGoToml({ branches: [SAMPLE_BRANCH, ZERO_BRANCH] }, wrapper)).toBe(
      `[[branches]]
  CreatedAt = 2026-05-27T01:02:03Z
  GitBranch = "feat-1"
  Id = "11111111-2222-3333-4444-555555555555"
  IsDefault = false
  Name = "feat-1"
  ParentProjectRef = "bbbbbbbbbbbbbbbbbbbb"
  Persistent = false
  ProjectRef = "aaaaaaaaaaaaaaaaaaaa"
  Status = "MIGRATIONS_PASSED"
  UpdatedAt = 2026-05-27T01:02:04Z
  WithData = true

[[branches]]
  CreatedAt = 0001-01-01T00:00:00Z
  Id = "00000000-0000-0000-0000-000000000000"
  IsDefault = true
  Name = "Production"
  ParentProjectRef = "production-project-ref"
  Persistent = false
  ProjectRef = "production-project-ref"
  Status = "FUNCTIONS_DEPLOYED"
  UpdatedAt = 0001-01-01T00:00:00Z
  WithData = false
`,
    );
  });

  it("emits a top-level struct without a table header (branches create)", () => {
    expect(encodeLegacyGoToml(SAMPLE_BRANCH, BRANCH_RESPONSE)).toBe(
      `CreatedAt = 2026-05-27T01:02:03Z
GitBranch = "feat-1"
Id = "11111111-2222-3333-4444-555555555555"
IsDefault = false
Name = "feat-1"
ParentProjectRef = "bbbbbbbbbbbbbbbbbbbb"
Persistent = false
ProjectRef = "aaaaaaaaaaaaaaaaaaaa"
Status = "MIGRATIONS_PASSED"
UpdatedAt = 2026-05-27T01:02:04Z
WithData = true
`,
    );
  });

  it("emits nothing for a nil list and `key = []` for a decoded empty list", () => {
    const wrapper = legacyGoTomlListWrapper("branches", BRANCH_RESPONSE);
    // Go: `var result []api.BranchResponse` stays nil when empty → no output.
    expect(encodeLegacyGoToml({ branches: undefined }, wrapper)).toBe("");
    // Go: a decoded `[]` is a non-nil empty slice → `branches = []`.
    expect(encodeLegacyGoToml({ branches: [] }, wrapper)).toBe("branches = []\n");
  });

  it("nests sub-tables after primitives with 2-space indentation (hostnames shape)", () => {
    // Mirror of api.UpdateCustomHostnameResponse.
    const spec = legacyGoStruct([
      ["custom_hostname", legacyGoString],
      [
        "data",
        legacyGoStruct([
          ["errors", legacyGoSlice(legacyGoAny)],
          ["messages", legacyGoSlice(legacyGoAny)],
          [
            "result",
            legacyGoStruct([
              ["custom_origin_server", legacyGoString],
              ["hostname", legacyGoString],
              ["id", legacyGoString],
              [
                "ownership_verification",
                legacyGoStruct([
                  ["name", legacyGoString],
                  ["type", legacyGoString],
                  ["value", legacyGoString],
                ]),
              ],
              [
                "ssl",
                legacyGoStruct([
                  ["status", legacyGoString],
                  ["validation_errors", legacyGoPtr(legacyGoSlice(legacyGoAny))],
                  [
                    "validation_records",
                    legacyGoSlice(
                      legacyGoStruct([
                        ["txt_name", legacyGoString],
                        ["txt_value", legacyGoString],
                      ]),
                    ),
                  ],
                ]),
              ],
              ["status", legacyGoString],
              ["verification_errors", legacyGoPtr(legacyGoSlice(legacyGoString))],
            ]),
          ],
          ["success", legacyGoBool],
        ]),
      ],
      ["status", legacyGoString],
    ]);
    const payload = {
      custom_hostname: "custom.example.com",
      status: "2_initiated",
      data: {
        success: true,
        result: {
          hostname: "custom.example.com",
          id: "hostname-id-1",
          status: "pending",
          ssl: {
            status: "pending_validation",
            validation_records: [{ txt_name: "_acme.example.com", txt_value: "token-1" }],
          },
          ownership_verification: {
            name: "_cf-custom-hostname.example.com",
            type: "txt",
            value: "value-1",
          },
        },
      },
    };
    expect(encodeLegacyGoToml(payload, spec)).toBe(
      `CustomHostname = "custom.example.com"
Status = "2_initiated"

[Data]
  Success = true
  [Data.Result]
    CustomOriginServer = ""
    Hostname = "custom.example.com"
    Id = "hostname-id-1"
    Status = "pending"
    [Data.Result.OwnershipVerification]
      Name = "_cf-custom-hostname.example.com"
      Type = "txt"
      Value = "value-1"
    [Data.Result.Ssl]
      Status = "pending_validation"

      [[Data.Result.Ssl.ValidationRecords]]
        TxtName = "_acme.example.com"
        TxtValue = "token-1"
`,
    );
  });

  it("escapes strings like BurntSushi and quotes string-typed timestamps (sso provider)", () => {
    const spec = legacyGoStruct([
      ["created_at", legacyGoPtr(legacyGoString)],
      [
        "domains",
        legacyGoPtr(
          legacyGoSlice(
            legacyGoStruct([
              ["created_at", legacyGoPtr(legacyGoString)],
              ["domain", legacyGoPtr(legacyGoString)],
              ["updated_at", legacyGoPtr(legacyGoString)],
            ]),
          ),
        ),
      ],
      ["id", legacyGoString],
      [
        "saml",
        legacyGoPtr(
          legacyGoStruct([
            [
              "attribute_mapping",
              legacyGoPtr(legacyGoStruct([["keys", legacyGoMap(legacyGoAny)]])),
            ],
            ["entity_id", legacyGoString],
            ["metadata_url", legacyGoPtr(legacyGoString)],
            ["metadata_xml", legacyGoPtr(legacyGoString)],
            ["name_id_format", legacyGoPtr(legacyGoString)],
          ]),
        ),
      ],
      ["updated_at", legacyGoPtr(legacyGoString)],
    ]);
    const payload = {
      id: "8b64a95d-6e29-4c58-8f04-1d0ac6bcda31",
      created_at: "2026-05-27T01:02:03.123456Z",
      updated_at: "2026-05-27T01:02:03.123456Z",
      domains: [{ domain: "example.com", created_at: "2026-05-27T01:02:03Z" }],
      saml: {
        entity_id: "https://example.com/saml/metadata",
        metadata_xml:
          '<?xml version="1.0"?>\n<EntityDescriptor entityID="https://example.com">&amp;</EntityDescriptor>',
      },
    };
    expect(encodeLegacyGoToml(payload, spec)).toBe(
      `CreatedAt = "2026-05-27T01:02:03.123456Z"
Id = "8b64a95d-6e29-4c58-8f04-1d0ac6bcda31"
UpdatedAt = "2026-05-27T01:02:03.123456Z"

[[Domains]]
  CreatedAt = "2026-05-27T01:02:03Z"
  Domain = "example.com"

[Saml]
  EntityId = "https://example.com/saml/metadata"
  MetadataXml = "<?xml version=\\"1.0\\"?>\\n<EntityDescriptor entityID=\\"https://example.com\\">&amp;</EntityDescriptor>"
`,
    );
  });

  it("keeps hand-written Go struct declaration order (services imageVersion)", () => {
    const spec = legacyGoTomlListWrapper(
      "services",
      legacyGoStruct([
        ["name", legacyGoString],
        ["local", legacyGoString],
        ["remote", legacyGoString],
      ]),
    );
    expect(
      encodeLegacyGoToml(
        { services: [{ name: "supabase/postgres", local: "17.4.1.037", remote: "" }] },
        spec,
      ),
    ).toBe(
      `[[services]]
  Name = "supabase/postgres"
  Local = "17.4.1.037"
  Remote = ""
`,
    );
  });

  it("renders inline primitive arrays (network bans wrapper)", () => {
    const spec = legacyGoStruct([["banned_ips", legacyGoSlice(legacyGoString), "banned_ips"]]);
    expect(encodeLegacyGoToml({ banned_ips: ["1.2.3.4", "5.6.7.8"] }, spec)).toBe(
      'banned_ips = ["1.2.3.4", "5.6.7.8"]\n',
    );
  });

  it("skips nil nullable fields and fails like Go on populated ones", () => {
    const spec = legacyGoStruct([
      ["desc", legacyGoNullable(legacyGoString)],
      ["name", legacyGoString],
    ]);
    expect(encodeLegacyGoToml({ name: "x" }, spec)).toBe('Name = "x"\n');
    expect(() => encodeLegacyGoToml({ name: "x", desc: null }, spec)).toThrow(
      new LegacyGoTomlEncodeError().message,
    );
    expect(() => encodeLegacyGoToml({ name: "x", desc: "d" }, spec)).toThrow(
      "toml: cannot encode a map with non-string key type",
    );
  });

  it("renders floats with a decimal point and Go's exponent form", () => {
    const spec = legacyGoStruct([
      ["f1", legacyGoFloat32],
      ["f2", legacyGoFloat64],
      ["f6", legacyGoFloat64],
    ]);
    expect(encodeLegacyGoToml({ f1: 1, f2: 1000000, f6: 1234567 }, spec)).toBe(
      `F1 = 1.0
F2 = 1e+06
F6 = 1.234567e+06
`,
    );
  });

  it("sorts map keys and quotes non-bare keys (branches get envs)", () => {
    const spec = legacyGoMap(legacyGoString);
    expect(
      encodeLegacyGoToml(
        { SUPABASE_ANON_KEY: "anon", POSTGRES_URL: "postgres://u:p@h:6543/postgres" },
        spec,
      ),
    ).toBe(
      `POSTGRES_URL = "postgres://u:p@h:6543/postgres"
SUPABASE_ANON_KEY = "anon"
`,
    );
  });

  it("renders map elements of mixed interface{} arrays as inline tables like BurntSushi", () => {
    const spec = legacyGoStruct([["default", legacyGoAny, "Default"]]);
    // Sorted byte order, non-table values before table values.
    expect(encodeLegacyGoToml({ default: [{ b: 2, a: 1, C: 3 }, "x"] }, spec)).toBe(
      'Default = [{C = 3.0, a = 1.0, b = 2.0}, "x"]\n',
    );
    expect(encodeLegacyGoToml({ default: [{ a: { b: 1 }, z: 2 }, "x"] }, spec)).toBe(
      'Default = [{z = 2.0, a = {b = 1.0}}, "x"]\n',
    );
    expect(encodeLegacyGoToml({ default: [{ a: [{ b: 1 }], z: 2 }, "x"] }, spec)).toBe(
      'Default = [{z = 2.0, a = [{b = 1.0}]}, "x"]\n',
    );
    // Non-bare keys are quoted; empty and all-nil tables collapse to {}.
    expect(encodeLegacyGoToml({ default: [{ "a b": 1 }, "x"] }, spec)).toBe(
      'Default = [{"a b" = 1.0}, "x"]\n',
    );
    expect(encodeLegacyGoToml({ default: [{}, "x"] }, spec)).toBe('Default = [{}, "x"]\n');
    expect(encodeLegacyGoToml({ default: [{ a: null }, "x"] }, spec)).toBe('Default = [{}, "x"]\n');
    // eMap decides the ", " separator by group position before skipping nil
    // entries, so a nil in the final position leaves a dangling separator.
    expect(encodeLegacyGoToml({ default: [{ "10": 78797, b: null }, false] }, spec)).toBe(
      "Default = [{10 = 78797.0, }, false]\n",
    );
  });

  it("fails like Go on nil elements inside interface{} arrays", () => {
    const spec = legacyGoStruct([["default", legacyGoAny, "Default"]]);
    const message = "toml: cannot encode array with nil element";
    expect(() => encodeLegacyGoToml({ default: [null, "x"] }, spec)).toThrow(message);
    expect(() => encodeLegacyGoToml({ default: [null] }, spec)).toThrow(message);
    expect(() => encodeLegacyGoToml({ default: [[null], "x"] }, spec)).toThrow(message);
  });

  it("truncates time fractions to nanoseconds like time.Time's decoder", () => {
    const spec = legacyGoStruct([["t", legacyGoTime, "T"]]);
    expect(encodeLegacyGoToml({ t: "2026-01-01T00:00:00.1234567895Z" }, spec)).toBe(
      "T = 2026-01-01T00:00:00.123456789Z\n",
    );
    expect(encodeLegacyGoToml({ t: "2026-01-01T00:00:00.1000000005Z" }, spec)).toBe(
      "T = 2026-01-01T00:00:00.1Z\n",
    );
  });

  it("quotes comma-fraction timestamp-shaped STRINGS like yaml.v3's resolver", () => {
    // Probed on go1.26: the string field "2026-01-01T00:00:00,123Z" is
    // double-quoted exactly like the dot form — yaml.v3 resolves timestamps
    // through time.Parse, which accepts either separator (review r3685767963).
    const spec = legacyGoStruct([["s", legacyGoString, "S"]]);
    expect(encodeLegacyGoYaml({ s: "2026-01-01T00:00:00,123Z" }, spec)).toBe(
      's: "2026-01-01T00:00:00,123Z"\n',
    );
  });

  it("leaves overflowing float-shaped strings plain like yaml.v3's ParseFloat gate", () => {
    // Probed on go1.26: resolve()'s strconv.ParseFloat ERRORS on overflow
    // (±Inf), so the value stays string-tagged and needs no quoting; an
    // underflowing exponent (1e-999 → 0) parses successfully and IS quoted
    // (review r3685767974).
    const spec = legacyGoStruct([["s", legacyGoString, "S"]]);
    expect(encodeLegacyGoYaml({ s: "1e999" }, spec)).toBe("s: 1e999\n");
    expect(encodeLegacyGoYaml({ s: "-1e999" }, spec)).toBe("s: -1e999\n");
    expect(encodeLegacyGoYaml({ s: ".5e999" }, spec)).toBe("s: .5e999\n");
    expect(encodeLegacyGoYaml({ s: "1e-999" }, spec)).toBe('s: "1e-999"\n');
    expect(encodeLegacyGoYaml({ s: "1e10" }, spec)).toBe('s: "1e10"\n');
  });

  it("wraps 19+-digit numeric key runs like Go's unchecked int64 accumulation", () => {
    // Probed on go1.26: `keyList.Less` accumulates into `int64` without
    // overflow checks, so `a10000000000000000000` wraps negative and sorts
    // BEFORE `a9000000000000000000` (review r3689635556).
    const spec = legacyGoStruct([["default", legacyGoAny, "Default"]]);
    expect(
      encodeLegacyGoYaml({ default: { a9000000000000000000: 1, a10000000000000000000: 2 } }, spec),
    ).toBe("default:\n    a10000000000000000000: 2\n    a9000000000000000000: 1\n");
  });

  it("orders Unicode-digit map keys with yaml.v3's naive rune arithmetic", () => {
    // Probed on go1.26: keyList.Less finds digit runs with unicode.IsDigit
    // but accumulates values as `rune - '0'`, so the Arabic-Indic key `a٢`
    // (U+0662) sorts AFTER a10, not as the number 2 (review r3685767973).
    const spec = legacyGoStruct([["default", legacyGoAny, "Default"]]);
    expect(encodeLegacyGoYaml({ default: { a٢: 1, a3: 2, a10: 3, a9: 4 } }, spec)).toBe(
      "default:\n    a3: 2\n    a9: 4\n    a10: 3\n    a٢: 1\n",
    );
  });

  it("normalizes Go's accepted comma fractional separator to the dot Go re-emits", () => {
    // Probed on go1.26: `time.Time.UnmarshalJSON` parses `…00,123Z`
    // (`commaOrPeriod`, `time/format.go`) and `json.Marshal` re-emits
    // `…00.123Z` — the encoders must match on both output formats.
    const spec = legacyGoStruct([["t", legacyGoTime, "T"]]);
    expect(encodeLegacyGoToml({ t: "2026-01-01T00:00:00,123Z" }, spec)).toBe(
      "T = 2026-01-01T00:00:00.123Z\n",
    );
    expect(encodeLegacyGoYaml({ t: "2026-01-01T00:00:00,1234567895Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789Z\n",
    );
  });

  it("sorts map keys by UTF-8 byte order like Go's sort.Strings", () => {
    // Go orders U+E000/U+FF21 before the astral U+1D400/U+1F600 (UTF-8 byte
    // order); JS `<` on UTF-16 units would sort both astral keys first.
    const spec = legacyGoMap(legacyGoString);
    expect(
      encodeLegacyGoToml(
        {
          "\u{1F600}": "emoji",
          "\uE000": "private-use",
          z: "ascii",
          é: "latin",
          Ａ: "fullwidth-A",
          "\u{1D400}": "math-bold-A",
        },
        spec,
      ),
    ).toBe(
      `z = "ascii"
"é" = "latin"
"\uE000" = "private-use"
"Ａ" = "fullwidth-A"
"\u{1D400}" = "math-bold-A"
"\u{1F600}" = "emoji"
`,
    );
  });
});

describe("encodeLegacyGoYaml", () => {
  it("matches Go byte-for-byte for a branches list (lowercased keys, explicit nulls)", () => {
    expect(encodeLegacyGoYaml([SAMPLE_BRANCH, ZERO_BRANCH], legacyGoSlice(BRANCH_RESPONSE))).toBe(
      `- createdat: 2026-05-27T01:02:03Z
  deletionscheduledat: null
  gitbranch: feat-1
  id: 11111111-2222-3333-4444-555555555555
  isdefault: false
  latestcheckrunid: null
  name: feat-1
  notifyurl: null
  parentprojectref: bbbbbbbbbbbbbbbbbbbb
  persistent: false
  prnumber: null
  previewprojectstatus: null
  projectref: aaaaaaaaaaaaaaaaaaaa
  reviewrequestedat: null
  status: MIGRATIONS_PASSED
  updatedat: 2026-05-27T01:02:04Z
  withdata: true
- createdat: 0001-01-01T00:00:00Z
  deletionscheduledat: null
  gitbranch: null
  id: 00000000-0000-0000-0000-000000000000
  isdefault: true
  latestcheckrunid: null
  name: Production
  notifyurl: null
  parentprojectref: production-project-ref
  persistent: false
  prnumber: null
  previewprojectstatus: null
  projectref: production-project-ref
  reviewrequestedat: null
  status: FUNCTIONS_DEPLOYED
  updatedat: 0001-01-01T00:00:00Z
  withdata: false
`,
    );
  });

  it("renders an empty list as [] regardless of nil-ness", () => {
    expect(encodeLegacyGoYaml([], legacyGoSlice(BRANCH_RESPONSE))).toBe("[]\n");
    expect(encodeLegacyGoYaml(undefined, legacyGoSlice(BRANCH_RESPONSE))).toBe("[]\n");
  });

  it("uses 4-column indentation, block literals, and quoted string timestamps (sso show)", () => {
    const spec = legacyGoStruct([
      ["created_at", legacyGoPtr(legacyGoString)],
      [
        "domains",
        legacyGoPtr(
          legacyGoSlice(
            legacyGoStruct([
              ["created_at", legacyGoPtr(legacyGoString)],
              ["domain", legacyGoPtr(legacyGoString)],
              ["updated_at", legacyGoPtr(legacyGoString)],
            ]),
          ),
        ),
      ],
      ["id", legacyGoString],
      [
        "saml",
        legacyGoPtr(
          legacyGoStruct([
            [
              "attribute_mapping",
              legacyGoPtr(legacyGoStruct([["keys", legacyGoMap(legacyGoAny)]])),
            ],
            ["entity_id", legacyGoString],
            ["metadata_url", legacyGoPtr(legacyGoString)],
            ["metadata_xml", legacyGoPtr(legacyGoString)],
            ["name_id_format", legacyGoPtr(legacyGoString)],
          ]),
        ),
      ],
      ["updated_at", legacyGoPtr(legacyGoString)],
    ]);
    const payload = {
      id: "8b64a95d-6e29-4c58-8f04-1d0ac6bcda31",
      created_at: "2026-05-27T01:02:03.123456Z",
      updated_at: "2026-05-27T01:02:03.123456Z",
      domains: [{ domain: "example.com", created_at: "2026-05-27T01:02:03Z" }],
      saml: {
        entity_id: "https://example.com/saml/metadata",
        metadata_xml:
          '<?xml version="1.0"?>\n<EntityDescriptor entityID="https://example.com">&amp;</EntityDescriptor>',
      },
    };
    expect(encodeLegacyGoYaml(payload, spec)).toBe(
      `createdat: "2026-05-27T01:02:03.123456Z"
domains:
    - createdat: "2026-05-27T01:02:03Z"
      domain: example.com
      updatedat: null
id: 8b64a95d-6e29-4c58-8f04-1d0ac6bcda31
saml:
    attributemapping: null
    entityid: https://example.com/saml/metadata
    metadataurl: null
    metadataxml: |-
        <?xml version="1.0"?>
        <EntityDescriptor entityID="https://example.com">&amp;</EntityDescriptor>
    nameidformat: null
updatedat: "2026-05-27T01:02:03.123456Z"
`,
    );
  });

  it("renders nullable fields the way yaml.v3 renders map[bool]T (api keys)", () => {
    // Mirror of api.ApiKeyResponse.
    const spec = legacyGoSlice(
      legacyGoStruct([
        ["api_key", legacyGoNullable(legacyGoString)],
        ["description", legacyGoNullable(legacyGoString)],
        ["hash", legacyGoNullable(legacyGoString)],
        ["id", legacyGoNullable(legacyGoString)],
        ["inserted_at", legacyGoNullable(legacyGoTime)],
        ["name", legacyGoString],
        ["prefix", legacyGoNullable(legacyGoString)],
        ["secret_jwt_template", legacyGoNullable(legacyGoMap(legacyGoAny))],
        ["type", legacyGoNullable(legacyGoString)],
        ["updated_at", legacyGoNullable(legacyGoTime)],
      ]),
    );
    const payload = [
      { name: "anon", api_key: "anon-key-value", id: "key-id-1", type: "legacy" },
      { name: "service_role" },
    ];
    expect(encodeLegacyGoYaml(payload, spec)).toBe(
      `- apikey:
    true: anon-key-value
  description: {}
  hash: {}
  id:
    true: key-id-1
  insertedat: {}
  name: anon
  prefix: {}
  secretjwttemplate: {}
  type:
    true: legacy
  updatedat: {}
- apikey: {}
  description: {}
  hash: {}
  id: {}
  insertedat: {}
  name: service_role
  prefix: {}
  secretjwttemplate: {}
  type: {}
  updatedat: {}
`,
    );
  });

  it("renders an explicit JSON null nullable as a false-keyed zero (snippets description)", () => {
    const spec = legacyGoStruct([
      ["desc", legacyGoNullable(legacyGoString)],
      ["name", legacyGoString],
    ]);
    expect(encodeLegacyGoYaml({ desc: null, name: "x" }, spec)).toBe(
      `desc:
    false: ""
name: x
`,
    );
  });

  it("renders nil and empty slices as [] and nested maps at +4 (backups list)", () => {
    const spec = legacyGoStruct([
      [
        "backups",
        legacyGoSlice(
          legacyGoStruct([
            ["id", legacyGoInt],
            ["inserted_at", legacyGoString],
            ["is_physical_backup", legacyGoBool],
            ["status", legacyGoString],
          ]),
        ),
      ],
      [
        "physical_backup_data",
        legacyGoStruct([
          ["earliest_physical_backup_date_unix", legacyGoPtr(legacyGoInt)],
          ["latest_physical_backup_date_unix", legacyGoPtr(legacyGoInt)],
        ]),
      ],
      ["pitr_enabled", legacyGoBool],
      ["region", legacyGoString],
      ["walg_enabled", legacyGoBool],
    ]);
    const payload = {
      backups: [],
      physical_backup_data: { earliest_physical_backup_date_unix: 1687279254 },
      pitr_enabled: true,
      region: "us-east-1",
      walg_enabled: true,
    };
    expect(encodeLegacyGoYaml(payload, spec)).toBe(
      `backups: []
physicalbackupdata:
    earliestphysicalbackupdateunix: 1687279254
    latestphysicalbackupdateunix: null
pitrenabled: true
region: us-east-1
walgenabled: true
`,
    );
  });

  it("quotes strings exactly like yaml.v3's resolver and emitter", () => {
    const spec = legacyGoMap(legacyGoString);
    const payload = {
      k01: "yes",
      k04: "~",
      k07: " leading-space",
      k09: "has # hash",
      k10: "#leads",
      k16: "a:b",
      k17: "- dash",
      k18: "-dash",
      k20: "12:34",
      k21: "0123",
      k22: "+123",
      k25: "0o777",
      k31: "tab\there",
      k33: 'double "quotes" inside',
      k36: "<xml>&amp;</xml>",
      k37: "2002-12-14",
      k38: "null",
      k40: "=",
      k41: "<<",
      k43: "1_000",
      k44: "0x_1F",
      k45: "with: colon",
      k46: "",
      k47: "2026-05-27T01:02:03Z",
      k48: "true",
      k49: "1e5",
      k50: "17",
      k51: "17.4.1.037",
      k52: "2001-12-14 21:59:43.10 -5",
      k53: "2001-12-15 2:59:43.10",
    };
    expect(encodeLegacyGoYaml(payload, spec)).toBe(
      `k01: "yes"
k04: "~"
k07: ' leading-space'
k09: 'has # hash'
k10: '#leads'
k16: a:b
k17: '- dash'
k18: -dash
k20: "12:34"
k21: "0123"
k22: "+123"
k25: "0o777"
k31: "tab\\there"
k33: double "quotes" inside
k36: <xml>&amp;</xml>
k37: "2002-12-14"
k38: "null"
k40: =
k41: <<
k43: "1_000"
k44: "0x_1F"
k45: 'with: colon'
k46: ""
k47: "2026-05-27T01:02:03Z"
k48: "true"
k49: "1e5"
k50: "17"
k51: 17.4.1.037
k52: 2001-12-14 21:59:43.10 -5
k53: "2001-12-15 2:59:43.10"
`,
    );
  });

  it("renders block literal chomping indicators like yaml.v3", () => {
    const spec = legacyGoMap(legacyGoString);
    expect(
      encodeLegacyGoYaml(
        { k27: "line1\nline2\n", k28: "line1\nline2\n\n", k29: "with\rcarriage" },
        spec,
      ),
    ).toBe(
      `k27: |
    line1
    line2
k28: |+
    line1
    line2

k29: "with\\rcarriage"
`,
    );
  });

  it("renders floats with Go's g-format exponent switch", () => {
    const spec = legacyGoMap(legacyGoAny);
    expect(
      encodeLegacyGoYaml({ f2: 1000000, f3: 78125, f4: 0.5, f5: 0.000001, f6: 1234567 }, spec),
    ).toBe(
      `f2: 1e+06
f3: 78125
f4: 0.5
f5: 1e-06
f6: 1.234567e+06
`,
    );
  });

  it("sorts plain map keys with yaml.v3's natural ordering", () => {
    const spec = legacyGoMap(legacyGoString);
    expect(encodeLegacyGoYaml({ z: "1", a: "2", "10": "3", "2": "4", B: "5", b: "6" }, spec)).toBe(
      `"2": "4"
"10": "3"
B: "5"
a: "2"
b: "6"
z: "1"
`,
    );
  });

  it("sorts unicode map keys by rune and escapes astral keys like yaml.v3", () => {
    // keyList.Less compares runes, so the astral U+1F600/U+1D400 sort after
    // U+E000/U+FF21 (JS `<` on UTF-16 units would say the opposite), and the
    // emitter double-quotes astral characters (4-byte UTF-8 is not printable
    // to libyaml) as \U-escapes.
    const spec = legacyGoMap(legacyGoString);
    expect(
      encodeLegacyGoYaml(
        {
          "\u{1F600}": "emoji",
          "\uE000": "private-use",
          z: "ascii",
          é: "latin",
          Ａ: "fullwidth-A",
          "\u{1D400}": "math-bold-A",
        },
        spec,
      ),
    ).toBe(
      `\uE000: private-use
"\\U0001F600": emoji
z: ascii
é: latin
Ａ: fullwidth-A
"\\U0001D400": math-bold-A
`,
    );
  });

  it("validates calendar dates and zone offsets like time.Parse before quoting timestamps", () => {
    const spec = legacyGoMap(legacyGoString);
    expect(
      encodeLegacyGoYaml(
        {
          t01: "2025-02-31",
          t02: "2024-02-29",
          t03: "2023-02-29",
          t04: "2100-02-29",
          t05: "2000-02-29",
          t06: "2025-04-31",
          t07: "2025-01-01T00:00:00+24:00",
          t08: "2025-01-01T00:00:00+25:00",
          t09: "2025-01-01T00:00:00+23:99",
          t10: "2025-01-01T00:00:00+00:60",
          t11: "0000-02-29",
          t12: "1900-02-29",
        },
        spec,
      ),
    ).toBe(
      `t01: 2025-02-31
t02: "2024-02-29"
t03: 2023-02-29
t04: 2100-02-29
t05: "2000-02-29"
t06: 2025-04-31
t07: "2025-01-01T00:00:00+24:00"
t08: 2025-01-01T00:00:00+25:00
t09: 2025-01-01T00:00:00+23:99
t10: "2025-01-01T00:00:00+00:60"
t11: "0000-02-29"
t12: 1900-02-29
`,
    );
  });

  it("truncates time fractions to nanoseconds like time.Time's decoder", () => {
    const spec = legacyGoStruct([["t", legacyGoTime, "T"]]);
    // time's `parseNanoseconds` keeps at most 9 fractional digits (truncation,
    // not rounding), then RFC3339Nano trims trailing zeros.
    expect(encodeLegacyGoYaml({ t: "2026-01-01T00:00:00.1234567895Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789Z\n",
    );
    expect(encodeLegacyGoYaml({ t: "2026-01-01T00:00:00.12345678901234Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789Z\n",
    );
    expect(encodeLegacyGoYaml({ t: "2026-01-01T00:00:00.9999999999Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.999999999Z\n",
    );
    expect(encodeLegacyGoYaml({ t: "2026-01-01T00:00:00.1000000005Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.1Z\n",
    );
    expect(encodeLegacyGoYaml({ t: "2026-01-01T00:00:00.1234567895+07:00" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789+07:00\n",
    );
  });

  it("escapes non-printable scalars with \\x/\\u/\\U like yaml.v3's emitter", () => {
    const spec = legacyGoMap(legacyGoString);
    expect(
      encodeLegacyGoYaml(
        {
          e1: "a\uFEFFb",
          e2: "a\uFFFEb",
          e3: "mixed \u{1F600} emoji",
          e4: "\u{1D400}",
          e5: "nel\u0085break",
        },
        spec,
      ),
    ).toBe(
      `e1: "a\\uFEFFb"
e2: "a\\uFFFEb"
e3: "mixed \\U0001F600 emoji"
e4: "\\U0001D400"
e5: "nel\\Nbreak"
`,
    );
  });
});

describe("legacyGoFieldName", () => {
  it("capitalizes snake_case tokens like oapi-codegen", () => {
    expect(legacyGoFieldName("api_key")).toBe("ApiKey");
    expect(legacyGoFieldName("metadata_xml")).toBe("MetadataXml");
    expect(legacyGoFieldName("parent_project_ref")).toBe("ParentProjectRef");
    expect(legacyGoFieldName("ezbr_sha256")).toBe("EzbrSha256");
  });

  it("capitalizes the first letter of camelCase tags", () => {
    expect(legacyGoFieldName("appliedSuccessfully")).toBe("AppliedSuccessfully");
    expect(legacyGoFieldName("currentConfig")).toBe("CurrentConfig");
  });
});

describe("legacyGoFormatFloat", () => {
  it("matches strconv.FormatFloat(f, 'g', -1, 64)", () => {
    expect(legacyGoFormatFloat(1, 64)).toBe("1");
    expect(legacyGoFormatFloat(123456, 64)).toBe("123456");
    expect(legacyGoFormatFloat(1000000, 64)).toBe("1e+06");
    expect(legacyGoFormatFloat(1234567, 64)).toBe("1.234567e+06");
    expect(legacyGoFormatFloat(0.5, 64)).toBe("0.5");
    expect(legacyGoFormatFloat(0.000001, 64)).toBe("1e-06");
    expect(legacyGoFormatFloat(0, 64)).toBe("0");
    expect(legacyGoFormatFloat(-2.5, 64)).toBe("-2.5");
  });

  it("rounds through float32 like Go's typed fields", () => {
    expect(legacyGoFormatFloat(16777217, 32)).toBe("1.6777216e+07");
    expect(legacyGoFormatFloat(78125, 32)).toBe("78125");
    expect(legacyGoFormatFloat(0.5, 32)).toBe("0.5");
  });

  it("breaks exact shortest-digit ties to even like Ryu, not half-up", () => {
    // 4249.03125 sits exactly between the two shortest 8-digit candidates;
    // strconv keeps the even final digit both downward and upward.
    expect(legacyGoFormatFloat(4249.03125, 32)).toBe("4249.0312");
    expect(legacyGoFormatFloat(4249.09375, 32)).toBe("4249.0938");
    expect(legacyGoFormatFloat(123456789, 32)).toBe("1.2345679e+08");
    expect(legacyGoFormatFloat(1048575.5, 32)).toBe("1.0485755e+06");
    expect(legacyGoFormatFloat(8388607.5, 32)).toBe("8.3886075e+06");
    // Boundaries: smallest subnormal, subnormal→normal edge, and max finite.
    expect(legacyGoFormatFloat(1.401298464324817e-45, 32)).toBe("1e-45");
    expect(legacyGoFormatFloat(1.1754943508222875e-38, 32)).toBe("1.1754944e-38");
    expect(legacyGoFormatFloat(3.4028234663852886e38, 32)).toBe("3.4028235e+38");
    expect(legacyGoFormatFloat(-4249.03125, 32)).toBe("-4249.0312");
  });
});
