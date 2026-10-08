import { describe, expect, it } from "vitest";

import {
  TomlEncodeError,
  encodeStructToml,
  encodeStructYaml,
  shapeAny,
  shapeBool,
  pascalCaseFieldName,
  shapeFloat32,
  shapeFloat64,
  formatStructFloat,
  shapeInt,
  shapeMap,
  shapeNullable,
  shapePtr,
  shapeSlice,
  shapeString,
  shapeStruct,
  shapeTime,
  shapeTomlListWrapper,
  shapeUuid,
} from "./struct-output.encoders.ts";

// Mirrors the branch response struct.
const BRANCH_RESPONSE = shapeStruct([
  ["created_at", shapeTime],
  ["deletion_scheduled_at", shapePtr(shapeTime)],
  ["git_branch", shapePtr(shapeString)],
  ["id", shapeUuid],
  ["is_default", shapeBool],
  ["latest_check_run_id", shapePtr(shapeFloat32)],
  ["name", shapeString],
  ["notify_url", shapePtr(shapeString)],
  ["parent_project_ref", shapeString],
  ["persistent", shapeBool],
  ["pr_number", shapePtr(shapeInt)],
  ["preview_project_status", shapePtr(shapeString)],
  ["project_ref", shapeString],
  ["review_requested_at", shapePtr(shapeTime)],
  ["status", shapeString],
  ["updated_at", shapeTime],
  ["with_data", shapeBool],
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

// All pointer fields absent — the value fields are zero-filled.
const ZERO_BRANCH = {
  name: "Production",
  is_default: true,
  parent_project_ref: "production-project-ref",
  project_ref: "production-project-ref",
  status: "FUNCTIONS_DEPLOYED",
};

describe("encodeStructToml", () => {
  it("matches the golden output for a branches list wrapper (PascalCase, nil pointers omitted, native datetimes)", () => {
    const wrapper = shapeTomlListWrapper("branches", BRANCH_RESPONSE);
    expect(encodeStructToml({ branches: [SAMPLE_BRANCH, ZERO_BRANCH] }, wrapper)).toBe(
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
    expect(encodeStructToml(SAMPLE_BRANCH, BRANCH_RESPONSE)).toBe(
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
    const wrapper = shapeTomlListWrapper("branches", BRANCH_RESPONSE);
    // An absent list → no output.
    expect(encodeStructToml({ branches: undefined }, wrapper)).toBe("");
    // A decoded `[]` is an empty list → `branches = []`.
    expect(encodeStructToml({ branches: [] }, wrapper)).toBe("branches = []\n");
  });

  it("nests sub-tables after primitives with 2-space indentation (hostnames shape)", () => {
    // Mirrors the custom-hostname update response struct.
    const spec = shapeStruct([
      ["custom_hostname", shapeString],
      [
        "data",
        shapeStruct([
          ["errors", shapeSlice(shapeAny)],
          ["messages", shapeSlice(shapeAny)],
          [
            "result",
            shapeStruct([
              ["custom_origin_server", shapeString],
              ["hostname", shapeString],
              ["id", shapeString],
              [
                "ownership_verification",
                shapeStruct([
                  ["name", shapeString],
                  ["type", shapeString],
                  ["value", shapeString],
                ]),
              ],
              [
                "ssl",
                shapeStruct([
                  ["status", shapeString],
                  ["validation_errors", shapePtr(shapeSlice(shapeAny))],
                  [
                    "validation_records",
                    shapeSlice(
                      shapeStruct([
                        ["txt_name", shapeString],
                        ["txt_value", shapeString],
                      ]),
                    ),
                  ],
                ]),
              ],
              ["status", shapeString],
              ["verification_errors", shapePtr(shapeSlice(shapeString))],
            ]),
          ],
          ["success", shapeBool],
        ]),
      ],
      ["status", shapeString],
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
    expect(encodeStructToml(payload, spec)).toBe(
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
    const spec = shapeStruct([
      ["created_at", shapePtr(shapeString)],
      [
        "domains",
        shapePtr(
          shapeSlice(
            shapeStruct([
              ["created_at", shapePtr(shapeString)],
              ["domain", shapePtr(shapeString)],
              ["updated_at", shapePtr(shapeString)],
            ]),
          ),
        ),
      ],
      ["id", shapeString],
      [
        "saml",
        shapePtr(
          shapeStruct([
            ["attribute_mapping", shapePtr(shapeStruct([["keys", shapeMap(shapeAny)]]))],
            ["entity_id", shapeString],
            ["metadata_url", shapePtr(shapeString)],
            ["metadata_xml", shapePtr(shapeString)],
            ["name_id_format", shapePtr(shapeString)],
          ]),
        ),
      ],
      ["updated_at", shapePtr(shapeString)],
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
    expect(encodeStructToml(payload, spec)).toBe(
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

  it("keeps hand-written struct declaration order (services imageVersion)", () => {
    const spec = shapeTomlListWrapper(
      "services",
      shapeStruct([
        ["name", shapeString],
        ["local", shapeString],
        ["remote", shapeString],
      ]),
    );
    expect(
      encodeStructToml(
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
    const spec = shapeStruct([["banned_ips", shapeSlice(shapeString), "banned_ips"]]);
    expect(encodeStructToml({ banned_ips: ["1.2.3.4", "5.6.7.8"] }, spec)).toBe(
      'banned_ips = ["1.2.3.4", "5.6.7.8"]\n',
    );
  });

  it("skips nil nullable fields and fails on populated ones", () => {
    const spec = shapeStruct([
      ["desc", shapeNullable(shapeString)],
      ["name", shapeString],
    ]);
    expect(encodeStructToml({ name: "x" }, spec)).toBe('Name = "x"\n');
    expect(() => encodeStructToml({ name: "x", desc: null }, spec)).toThrow(
      new TomlEncodeError().message,
    );
    expect(() => encodeStructToml({ name: "x", desc: "d" }, spec)).toThrow(
      "toml: cannot encode a map with non-string key type",
    );
  });

  it("renders floats with a decimal point and the exponent form", () => {
    const spec = shapeStruct([
      ["f1", shapeFloat32],
      ["f2", shapeFloat64],
      ["f6", shapeFloat64],
    ]);
    expect(encodeStructToml({ f1: 1, f2: 1000000, f6: 1234567 }, spec)).toBe(
      `F1 = 1.0
F2 = 1e+06
F6 = 1.234567e+06
`,
    );
  });

  it("sorts map keys and quotes non-bare keys (branches get envs)", () => {
    const spec = shapeMap(shapeString);
    expect(
      encodeStructToml(
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
    const spec = shapeStruct([["default", shapeAny, "Default"]]);
    // Sorted byte order, non-table values before table values.
    expect(encodeStructToml({ default: [{ b: 2, a: 1, C: 3 }, "x"] }, spec)).toBe(
      'Default = [{C = 3.0, a = 1.0, b = 2.0}, "x"]\n',
    );
    expect(encodeStructToml({ default: [{ a: { b: 1 }, z: 2 }, "x"] }, spec)).toBe(
      'Default = [{z = 2.0, a = {b = 1.0}}, "x"]\n',
    );
    expect(encodeStructToml({ default: [{ a: [{ b: 1 }], z: 2 }, "x"] }, spec)).toBe(
      'Default = [{z = 2.0, a = [{b = 1.0}]}, "x"]\n',
    );
    // Non-bare keys are quoted; empty and all-nil tables collapse to {}.
    expect(encodeStructToml({ default: [{ "a b": 1 }, "x"] }, spec)).toBe(
      'Default = [{"a b" = 1.0}, "x"]\n',
    );
    expect(encodeStructToml({ default: [{}, "x"] }, spec)).toBe('Default = [{}, "x"]\n');
    expect(encodeStructToml({ default: [{ a: null }, "x"] }, spec)).toBe('Default = [{}, "x"]\n');
    // eMap decides the ", " separator by group position before skipping nil
    // entries, so a nil in the final position leaves a dangling separator.
    expect(encodeStructToml({ default: [{ "10": 78797, b: null }, false] }, spec)).toBe(
      "Default = [{10 = 78797.0, }, false]\n",
    );
  });

  it("fails on nil elements inside untyped arrays", () => {
    const spec = shapeStruct([["default", shapeAny, "Default"]]);
    const message = "toml: cannot encode array with nil element";
    expect(() => encodeStructToml({ default: [null, "x"] }, spec)).toThrow(message);
    expect(() => encodeStructToml({ default: [null] }, spec)).toThrow(message);
    expect(() => encodeStructToml({ default: [[null], "x"] }, spec)).toThrow(message);
  });

  it("truncates time fractions to nanoseconds like time.Time's decoder", () => {
    const spec = shapeStruct([["t", shapeTime, "T"]]);
    expect(encodeStructToml({ t: "2026-01-01T00:00:00.1234567895Z" }, spec)).toBe(
      "T = 2026-01-01T00:00:00.123456789Z\n",
    );
    expect(encodeStructToml({ t: "2026-01-01T00:00:00.1000000005Z" }, spec)).toBe(
      "T = 2026-01-01T00:00:00.1Z\n",
    );
  });

  it("quotes comma-fraction timestamp-shaped STRINGS like yaml.v3's resolver", () => {
    const spec = shapeStruct([["s", shapeString, "S"]]);
    expect(encodeStructYaml({ s: "2026-01-01T00:00:00,123Z" }, spec)).toBe(
      's: "2026-01-01T00:00:00,123Z"\n',
    );
  });

  it("leaves overflowing float-shaped strings plain", () => {
    const spec = shapeStruct([["s", shapeString, "S"]]);
    expect(encodeStructYaml({ s: "1e999" }, spec)).toBe("s: 1e999\n");
    expect(encodeStructYaml({ s: "-1e999" }, spec)).toBe("s: -1e999\n");
    expect(encodeStructYaml({ s: ".5e999" }, spec)).toBe("s: .5e999\n");
    expect(encodeStructYaml({ s: "1e-999" }, spec)).toBe('s: "1e-999"\n');
    expect(encodeStructYaml({ s: "1e10" }, spec)).toBe('s: "1e10"\n');
  });

  it("wraps 19+-digit numeric key runs via unchecked int64 accumulation", () => {
    const spec = shapeStruct([["default", shapeAny, "Default"]]);
    expect(
      encodeStructYaml({ default: { a9000000000000000000: 1, a10000000000000000000: 2 } }, spec),
    ).toBe("default:\n    a10000000000000000000: 2\n    a9000000000000000000: 1\n");
  });

  it("orders Unicode-digit map keys with yaml.v3's naive rune arithmetic", () => {
    const spec = shapeStruct([["default", shapeAny, "Default"]]);
    expect(encodeStructYaml({ default: { a٢: 1, a3: 2, a10: 3, a9: 4 } }, spec)).toBe(
      "default:\n    a3: 2\n    a9: 4\n    a10: 3\n    a٢: 1\n",
    );
  });

  it("normalizes a comma fractional separator to a dot", () => {
    const spec = shapeStruct([["t", shapeTime, "T"]]);
    expect(encodeStructToml({ t: "2026-01-01T00:00:00,123Z" }, spec)).toBe(
      "T = 2026-01-01T00:00:00.123Z\n",
    );
    expect(encodeStructYaml({ t: "2026-01-01T00:00:00,1234567895Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789Z\n",
    );
  });

  it("sorts map keys by UTF-8 byte order", () => {
    // U+E000/U+FF21 sort before the astral U+1D400/U+1F600 in UTF-8 byte order; JS `<` on UTF-16
    // units would sort both astral keys first.
    const spec = shapeMap(shapeString);
    expect(
      encodeStructToml(
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

describe("encodeStructYaml", () => {
  it("matches the golden output for a branches list (lowercased keys, explicit nulls)", () => {
    expect(encodeStructYaml([SAMPLE_BRANCH, ZERO_BRANCH], shapeSlice(BRANCH_RESPONSE))).toBe(
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
    expect(encodeStructYaml([], shapeSlice(BRANCH_RESPONSE))).toBe("[]\n");
    expect(encodeStructYaml(undefined, shapeSlice(BRANCH_RESPONSE))).toBe("[]\n");
  });

  it("uses 4-column indentation, block literals, and quoted string timestamps (sso show)", () => {
    const spec = shapeStruct([
      ["created_at", shapePtr(shapeString)],
      [
        "domains",
        shapePtr(
          shapeSlice(
            shapeStruct([
              ["created_at", shapePtr(shapeString)],
              ["domain", shapePtr(shapeString)],
              ["updated_at", shapePtr(shapeString)],
            ]),
          ),
        ),
      ],
      ["id", shapeString],
      [
        "saml",
        shapePtr(
          shapeStruct([
            ["attribute_mapping", shapePtr(shapeStruct([["keys", shapeMap(shapeAny)]]))],
            ["entity_id", shapeString],
            ["metadata_url", shapePtr(shapeString)],
            ["metadata_xml", shapePtr(shapeString)],
            ["name_id_format", shapePtr(shapeString)],
          ]),
        ),
      ],
      ["updated_at", shapePtr(shapeString)],
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
    expect(encodeStructYaml(payload, spec)).toBe(
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
    const spec = shapeSlice(
      shapeStruct([
        ["api_key", shapeNullable(shapeString)],
        ["description", shapeNullable(shapeString)],
        ["hash", shapeNullable(shapeString)],
        ["id", shapeNullable(shapeString)],
        ["inserted_at", shapeNullable(shapeTime)],
        ["name", shapeString],
        ["prefix", shapeNullable(shapeString)],
        ["secret_jwt_template", shapeNullable(shapeMap(shapeAny))],
        ["type", shapeNullable(shapeString)],
        ["updated_at", shapeNullable(shapeTime)],
      ]),
    );
    const payload = [
      { name: "anon", api_key: "anon-key-value", id: "key-id-1", type: "legacy" },
      { name: "service_role" },
    ];
    expect(encodeStructYaml(payload, spec)).toBe(
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
    const spec = shapeStruct([
      ["desc", shapeNullable(shapeString)],
      ["name", shapeString],
    ]);
    expect(encodeStructYaml({ desc: null, name: "x" }, spec)).toBe(
      `desc:
    false: ""
name: x
`,
    );
  });

  it("renders nil and empty slices as [] and nested maps at +4 (backups list)", () => {
    const spec = shapeStruct([
      [
        "backups",
        shapeSlice(
          shapeStruct([
            ["id", shapeInt],
            ["inserted_at", shapeString],
            ["is_physical_backup", shapeBool],
            ["status", shapeString],
          ]),
        ),
      ],
      [
        "physical_backup_data",
        shapeStruct([
          ["earliest_physical_backup_date_unix", shapePtr(shapeInt)],
          ["latest_physical_backup_date_unix", shapePtr(shapeInt)],
        ]),
      ],
      ["pitr_enabled", shapeBool],
      ["region", shapeString],
      ["walg_enabled", shapeBool],
    ]);
    const payload = {
      backups: [],
      physical_backup_data: { earliest_physical_backup_date_unix: 1687279254 },
      pitr_enabled: true,
      region: "us-east-1",
      walg_enabled: true,
    };
    expect(encodeStructYaml(payload, spec)).toBe(
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
    const spec = shapeMap(shapeString);
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
    expect(encodeStructYaml(payload, spec)).toBe(
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
    const spec = shapeMap(shapeString);
    expect(
      encodeStructYaml(
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

  it("renders floats with the g-format exponent switch", () => {
    const spec = shapeMap(shapeAny);
    expect(
      encodeStructYaml({ f2: 1000000, f3: 78125, f4: 0.5, f5: 0.000001, f6: 1234567 }, spec),
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
    const spec = shapeMap(shapeString);
    expect(encodeStructYaml({ z: "1", a: "2", "10": "3", "2": "4", B: "5", b: "6" }, spec)).toBe(
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
    // keyList.Less compares runes, so the astral U+1F600/U+1D400 sort after U+E000/U+FF21; the
    // emitter double-quotes astral characters as \U-escapes (not printable to libyaml).
    const spec = shapeMap(shapeString);
    expect(
      encodeStructYaml(
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
    const spec = shapeMap(shapeString);
    expect(
      encodeStructYaml(
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
    const spec = shapeStruct([["t", shapeTime, "T"]]);
    expect(encodeStructYaml({ t: "2026-01-01T00:00:00.1234567895Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789Z\n",
    );
    expect(encodeStructYaml({ t: "2026-01-01T00:00:00.12345678901234Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789Z\n",
    );
    expect(encodeStructYaml({ t: "2026-01-01T00:00:00.9999999999Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.999999999Z\n",
    );
    expect(encodeStructYaml({ t: "2026-01-01T00:00:00.1000000005Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.1Z\n",
    );
    expect(encodeStructYaml({ t: "2026-01-01T00:00:00.1234567895+07:00" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789+07:00\n",
    );
  });

  it("escapes non-printable scalars with \\x/\\u/\\U like yaml.v3's emitter", () => {
    const spec = shapeMap(shapeString);
    expect(
      encodeStructYaml(
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

describe("pascalCaseFieldName", () => {
  it("capitalizes snake_case tokens like oapi-codegen", () => {
    expect(pascalCaseFieldName("api_key")).toBe("ApiKey");
    expect(pascalCaseFieldName("metadata_xml")).toBe("MetadataXml");
    expect(pascalCaseFieldName("parent_project_ref")).toBe("ParentProjectRef");
    expect(pascalCaseFieldName("ezbr_sha256")).toBe("EzbrSha256");
  });

  it("capitalizes the first letter of camelCase tags", () => {
    expect(pascalCaseFieldName("appliedSuccessfully")).toBe("AppliedSuccessfully");
    expect(pascalCaseFieldName("currentConfig")).toBe("CurrentConfig");
  });
});

describe("formatStructFloat", () => {
  it("formats shortest `%g` digits for 64-bit floats", () => {
    expect(formatStructFloat(1, 64)).toBe("1");
    expect(formatStructFloat(123456, 64)).toBe("123456");
    expect(formatStructFloat(1000000, 64)).toBe("1e+06");
    expect(formatStructFloat(1234567, 64)).toBe("1.234567e+06");
    expect(formatStructFloat(0.5, 64)).toBe("0.5");
    expect(formatStructFloat(0.000001, 64)).toBe("1e-06");
    expect(formatStructFloat(0, 64)).toBe("0");
    expect(formatStructFloat(-2.5, 64)).toBe("-2.5");
  });

  it("rounds through float32 for typed fields", () => {
    expect(formatStructFloat(16777217, 32)).toBe("1.6777216e+07");
    expect(formatStructFloat(78125, 32)).toBe("78125");
    expect(formatStructFloat(0.5, 32)).toBe("0.5");
  });

  it("breaks exact shortest-digit ties to even like Ryu, not half-up", () => {
    // 4249.03125 sits exactly between the two shortest 8-digit candidates, rounding to the even
    // final digit both ways.
    expect(formatStructFloat(4249.03125, 32)).toBe("4249.0312");
    expect(formatStructFloat(4249.09375, 32)).toBe("4249.0938");
    expect(formatStructFloat(123456789, 32)).toBe("1.2345679e+08");
    expect(formatStructFloat(1048575.5, 32)).toBe("1.0485755e+06");
    expect(formatStructFloat(8388607.5, 32)).toBe("8.3886075e+06");
    // Boundaries: smallest subnormal, subnormal→normal edge, and max finite.
    expect(formatStructFloat(1.401298464324817e-45, 32)).toBe("1e-45");
    expect(formatStructFloat(1.1754943508222875e-38, 32)).toBe("1.1754944e-38");
    expect(formatStructFloat(3.4028234663852886e38, 32)).toBe("3.4028235e+38");
    expect(formatStructFloat(-4249.03125, 32)).toBe("-4249.0312");
  });
});
