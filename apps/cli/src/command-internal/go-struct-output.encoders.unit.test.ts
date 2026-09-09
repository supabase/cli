import { describe, expect, it } from "vitest";

import {
  GoTomlEncodeError,
  encodeGoToml,
  encodeGoYaml,
  goAny,
  goBool,
  goFieldName,
  goFloat32,
  goFloat64,
  goFormatFloat,
  goInt,
  goMap,
  goNullable,
  goPtr,
  goSlice,
  goString,
  goStruct,
  goTime,
  goTomlListWrapper,
  goUuid,
} from "./go-struct-output.encoders.ts";

/**
 * Every golden byte string in this file was captured from a scratch Go
 * program calling the established `utils.EncodeOutput`
 * with BurntSushi toml v1.6.0 and
 * yaml.v3 v3.0.1 — the exact library versions pinned in the reference `go.mod`.
 */

// Mirror of `api.BranchResponse` (apps/cli-go/pkg/api/types.gen.go).
const BRANCH_RESPONSE = goStruct([
  ["created_at", goTime],
  ["deletion_scheduled_at", goPtr(goTime)],
  ["git_branch", goPtr(goString)],
  ["id", goUuid],
  ["is_default", goBool],
  ["latest_check_run_id", goPtr(goFloat32)],
  ["name", goString],
  ["notify_url", goPtr(goString)],
  ["parent_project_ref", goString],
  ["persistent", goBool],
  ["pr_number", goPtr(goInt)],
  ["preview_project_status", goPtr(goString)],
  ["project_ref", goString],
  ["review_requested_at", goPtr(goTime)],
  ["status", goString],
  ["updated_at", goTime],
  ["with_data", goBool],
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

describe("encodeGoToml", () => {
  it("matches Go byte-for-byte for a branches list wrapper (PascalCase, nil pointers omitted, native datetimes)", () => {
    const wrapper = goTomlListWrapper("branches", BRANCH_RESPONSE);
    expect(encodeGoToml({ branches: [SAMPLE_BRANCH, ZERO_BRANCH] }, wrapper)).toBe(
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
    expect(encodeGoToml(SAMPLE_BRANCH, BRANCH_RESPONSE)).toBe(
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
    const wrapper = goTomlListWrapper("branches", BRANCH_RESPONSE);
    // Go: `var result []api.BranchResponse` stays nil when empty → no output.
    expect(encodeGoToml({ branches: undefined }, wrapper)).toBe("");
    // Go: a decoded `[]` is a non-nil empty slice → `branches = []`.
    expect(encodeGoToml({ branches: [] }, wrapper)).toBe("branches = []\n");
  });

  it("nests sub-tables after primitives with 2-space indentation (hostnames shape)", () => {
    // Mirror of api.UpdateCustomHostnameResponse.
    const spec = goStruct([
      ["custom_hostname", goString],
      [
        "data",
        goStruct([
          ["errors", goSlice(goAny)],
          ["messages", goSlice(goAny)],
          [
            "result",
            goStruct([
              ["custom_origin_server", goString],
              ["hostname", goString],
              ["id", goString],
              [
                "ownership_verification",
                goStruct([
                  ["name", goString],
                  ["type", goString],
                  ["value", goString],
                ]),
              ],
              [
                "ssl",
                goStruct([
                  ["status", goString],
                  ["validation_errors", goPtr(goSlice(goAny))],
                  [
                    "validation_records",
                    goSlice(
                      goStruct([
                        ["txt_name", goString],
                        ["txt_value", goString],
                      ]),
                    ),
                  ],
                ]),
              ],
              ["status", goString],
              ["verification_errors", goPtr(goSlice(goString))],
            ]),
          ],
          ["success", goBool],
        ]),
      ],
      ["status", goString],
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
    expect(encodeGoToml(payload, spec)).toBe(
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
    const spec = goStruct([
      ["created_at", goPtr(goString)],
      [
        "domains",
        goPtr(
          goSlice(
            goStruct([
              ["created_at", goPtr(goString)],
              ["domain", goPtr(goString)],
              ["updated_at", goPtr(goString)],
            ]),
          ),
        ),
      ],
      ["id", goString],
      [
        "saml",
        goPtr(
          goStruct([
            ["attribute_mapping", goPtr(goStruct([["keys", goMap(goAny)]]))],
            ["entity_id", goString],
            ["metadata_url", goPtr(goString)],
            ["metadata_xml", goPtr(goString)],
            ["name_id_format", goPtr(goString)],
          ]),
        ),
      ],
      ["updated_at", goPtr(goString)],
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
    expect(encodeGoToml(payload, spec)).toBe(
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
    const spec = goTomlListWrapper(
      "services",
      goStruct([
        ["name", goString],
        ["local", goString],
        ["remote", goString],
      ]),
    );
    expect(
      encodeGoToml(
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
    const spec = goStruct([["banned_ips", goSlice(goString), "banned_ips"]]);
    expect(encodeGoToml({ banned_ips: ["1.2.3.4", "5.6.7.8"] }, spec)).toBe(
      'banned_ips = ["1.2.3.4", "5.6.7.8"]\n',
    );
  });

  it("skips nil nullable fields and fails like Go on populated ones", () => {
    const spec = goStruct([
      ["desc", goNullable(goString)],
      ["name", goString],
    ]);
    expect(encodeGoToml({ name: "x" }, spec)).toBe('Name = "x"\n');
    expect(() => encodeGoToml({ name: "x", desc: null }, spec)).toThrow(
      new GoTomlEncodeError().message,
    );
    expect(() => encodeGoToml({ name: "x", desc: "d" }, spec)).toThrow(
      "toml: cannot encode a map with non-string key type",
    );
  });

  it("renders floats with a decimal point and Go's exponent form", () => {
    const spec = goStruct([
      ["f1", goFloat32],
      ["f2", goFloat64],
      ["f6", goFloat64],
    ]);
    expect(encodeGoToml({ f1: 1, f2: 1000000, f6: 1234567 }, spec)).toBe(
      `F1 = 1.0
F2 = 1e+06
F6 = 1.234567e+06
`,
    );
  });

  it("sorts map keys and quotes non-bare keys (branches get envs)", () => {
    const spec = goMap(goString);
    expect(
      encodeGoToml(
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
    const spec = goStruct([["default", goAny, "Default"]]);
    // Sorted byte order, non-table values before table values.
    expect(encodeGoToml({ default: [{ b: 2, a: 1, C: 3 }, "x"] }, spec)).toBe(
      'Default = [{C = 3.0, a = 1.0, b = 2.0}, "x"]\n',
    );
    expect(encodeGoToml({ default: [{ a: { b: 1 }, z: 2 }, "x"] }, spec)).toBe(
      'Default = [{z = 2.0, a = {b = 1.0}}, "x"]\n',
    );
    expect(encodeGoToml({ default: [{ a: [{ b: 1 }], z: 2 }, "x"] }, spec)).toBe(
      'Default = [{z = 2.0, a = [{b = 1.0}]}, "x"]\n',
    );
    // Non-bare keys are quoted; empty and all-nil tables collapse to {}.
    expect(encodeGoToml({ default: [{ "a b": 1 }, "x"] }, spec)).toBe(
      'Default = [{"a b" = 1.0}, "x"]\n',
    );
    expect(encodeGoToml({ default: [{}, "x"] }, spec)).toBe('Default = [{}, "x"]\n');
    expect(encodeGoToml({ default: [{ a: null }, "x"] }, spec)).toBe('Default = [{}, "x"]\n');
    // eMap decides the ", " separator by group position before skipping nil
    // entries, so a nil in the final position leaves a dangling separator.
    expect(encodeGoToml({ default: [{ "10": 78797, b: null }, false] }, spec)).toBe(
      "Default = [{10 = 78797.0, }, false]\n",
    );
  });

  it("fails like Go on nil elements inside interface{} arrays", () => {
    const spec = goStruct([["default", goAny, "Default"]]);
    const message = "toml: cannot encode array with nil element";
    expect(() => encodeGoToml({ default: [null, "x"] }, spec)).toThrow(message);
    expect(() => encodeGoToml({ default: [null] }, spec)).toThrow(message);
    expect(() => encodeGoToml({ default: [[null], "x"] }, spec)).toThrow(message);
  });

  it("truncates time fractions to nanoseconds like time.Time's decoder", () => {
    const spec = goStruct([["t", goTime, "T"]]);
    expect(encodeGoToml({ t: "2026-01-01T00:00:00.1234567895Z" }, spec)).toBe(
      "T = 2026-01-01T00:00:00.123456789Z\n",
    );
    expect(encodeGoToml({ t: "2026-01-01T00:00:00.1000000005Z" }, spec)).toBe(
      "T = 2026-01-01T00:00:00.1Z\n",
    );
  });

  it("quotes comma-fraction timestamp-shaped STRINGS like yaml.v3's resolver", () => {
    // Probed on go1.26: the string field "2026-01-01T00:00:00,123Z" is
    // double-quoted exactly like the dot form — yaml.v3 resolves timestamps
    // through time.Parse, which accepts either separator (review r3685767963).
    const spec = goStruct([["s", goString, "S"]]);
    expect(encodeGoYaml({ s: "2026-01-01T00:00:00,123Z" }, spec)).toBe(
      's: "2026-01-01T00:00:00,123Z"\n',
    );
  });

  it("leaves overflowing float-shaped strings plain like yaml.v3's ParseFloat gate", () => {
    // Probed on go1.26: resolve()'s strconv.ParseFloat ERRORS on overflow
    // (±Inf), so the value stays string-tagged and needs no quoting; an
    // underflowing exponent (1e-999 → 0) parses successfully and IS quoted
    // (review r3685767974).
    const spec = goStruct([["s", goString, "S"]]);
    expect(encodeGoYaml({ s: "1e999" }, spec)).toBe("s: 1e999\n");
    expect(encodeGoYaml({ s: "-1e999" }, spec)).toBe("s: -1e999\n");
    expect(encodeGoYaml({ s: ".5e999" }, spec)).toBe("s: .5e999\n");
    expect(encodeGoYaml({ s: "1e-999" }, spec)).toBe('s: "1e-999"\n');
    expect(encodeGoYaml({ s: "1e10" }, spec)).toBe('s: "1e10"\n');
  });

  it("wraps 19+-digit numeric key runs like Go's unchecked int64 accumulation", () => {
    // Probed on go1.26: `keyList.Less` accumulates into `int64` without
    // overflow checks, so `a10000000000000000000` wraps negative and sorts
    // BEFORE `a9000000000000000000` (review r3689635556).
    const spec = goStruct([["default", goAny, "Default"]]);
    expect(
      encodeGoYaml({ default: { a9000000000000000000: 1, a10000000000000000000: 2 } }, spec),
    ).toBe("default:\n    a10000000000000000000: 2\n    a9000000000000000000: 1\n");
  });

  it("orders Unicode-digit map keys with yaml.v3's naive rune arithmetic", () => {
    // Probed on go1.26: keyList.Less finds digit runs with unicode.IsDigit
    // but accumulates values as `rune - '0'`, so the Arabic-Indic key `a٢`
    // (U+0662) sorts AFTER a10, not as the number 2 (review r3685767973).
    const spec = goStruct([["default", goAny, "Default"]]);
    expect(encodeGoYaml({ default: { a٢: 1, a3: 2, a10: 3, a9: 4 } }, spec)).toBe(
      "default:\n    a3: 2\n    a9: 4\n    a10: 3\n    a٢: 1\n",
    );
  });

  it("normalizes Go's accepted comma fractional separator to the dot Go re-emits", () => {
    // Probed on go1.26: `time.Time.UnmarshalJSON` parses `…00,123Z`
    // (`commaOrPeriod`, `time/format.go`) and `json.Marshal` re-emits
    // `…00.123Z` — the encoders must match on both output formats.
    const spec = goStruct([["t", goTime, "T"]]);
    expect(encodeGoToml({ t: "2026-01-01T00:00:00,123Z" }, spec)).toBe(
      "T = 2026-01-01T00:00:00.123Z\n",
    );
    expect(encodeGoYaml({ t: "2026-01-01T00:00:00,1234567895Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789Z\n",
    );
  });

  it("sorts map keys by UTF-8 byte order like Go's sort.Strings", () => {
    // Go orders U+E000/U+FF21 before the astral U+1D400/U+1F600 (UTF-8 byte
    // order); JS `<` on UTF-16 units would sort both astral keys first.
    const spec = goMap(goString);
    expect(
      encodeGoToml(
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

describe("encodeGoYaml", () => {
  it("matches Go byte-for-byte for a branches list (lowercased keys, explicit nulls)", () => {
    expect(encodeGoYaml([SAMPLE_BRANCH, ZERO_BRANCH], goSlice(BRANCH_RESPONSE))).toBe(
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
    expect(encodeGoYaml([], goSlice(BRANCH_RESPONSE))).toBe("[]\n");
    expect(encodeGoYaml(undefined, goSlice(BRANCH_RESPONSE))).toBe("[]\n");
  });

  it("uses 4-column indentation, block literals, and quoted string timestamps (sso show)", () => {
    const spec = goStruct([
      ["created_at", goPtr(goString)],
      [
        "domains",
        goPtr(
          goSlice(
            goStruct([
              ["created_at", goPtr(goString)],
              ["domain", goPtr(goString)],
              ["updated_at", goPtr(goString)],
            ]),
          ),
        ),
      ],
      ["id", goString],
      [
        "saml",
        goPtr(
          goStruct([
            ["attribute_mapping", goPtr(goStruct([["keys", goMap(goAny)]]))],
            ["entity_id", goString],
            ["metadata_url", goPtr(goString)],
            ["metadata_xml", goPtr(goString)],
            ["name_id_format", goPtr(goString)],
          ]),
        ),
      ],
      ["updated_at", goPtr(goString)],
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
    expect(encodeGoYaml(payload, spec)).toBe(
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
    const spec = goSlice(
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
    const payload = [
      { name: "anon", api_key: "anon-key-value", id: "key-id-1", type: "legacy" },
      { name: "service_role" },
    ];
    expect(encodeGoYaml(payload, spec)).toBe(
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
    const spec = goStruct([
      ["desc", goNullable(goString)],
      ["name", goString],
    ]);
    expect(encodeGoYaml({ desc: null, name: "x" }, spec)).toBe(
      `desc:
    false: ""
name: x
`,
    );
  });

  it("renders nil and empty slices as [] and nested maps at +4 (backups list)", () => {
    const spec = goStruct([
      [
        "backups",
        goSlice(
          goStruct([
            ["id", goInt],
            ["inserted_at", goString],
            ["is_physical_backup", goBool],
            ["status", goString],
          ]),
        ),
      ],
      [
        "physical_backup_data",
        goStruct([
          ["earliest_physical_backup_date_unix", goPtr(goInt)],
          ["latest_physical_backup_date_unix", goPtr(goInt)],
        ]),
      ],
      ["pitr_enabled", goBool],
      ["region", goString],
      ["walg_enabled", goBool],
    ]);
    const payload = {
      backups: [],
      physical_backup_data: { earliest_physical_backup_date_unix: 1687279254 },
      pitr_enabled: true,
      region: "us-east-1",
      walg_enabled: true,
    };
    expect(encodeGoYaml(payload, spec)).toBe(
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
    const spec = goMap(goString);
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
    expect(encodeGoYaml(payload, spec)).toBe(
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
    const spec = goMap(goString);
    expect(
      encodeGoYaml({ k27: "line1\nline2\n", k28: "line1\nline2\n\n", k29: "with\rcarriage" }, spec),
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
    const spec = goMap(goAny);
    expect(encodeGoYaml({ f2: 1000000, f3: 78125, f4: 0.5, f5: 0.000001, f6: 1234567 }, spec)).toBe(
      `f2: 1e+06
f3: 78125
f4: 0.5
f5: 1e-06
f6: 1.234567e+06
`,
    );
  });

  it("sorts plain map keys with yaml.v3's natural ordering", () => {
    const spec = goMap(goString);
    expect(encodeGoYaml({ z: "1", a: "2", "10": "3", "2": "4", B: "5", b: "6" }, spec)).toBe(
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
    const spec = goMap(goString);
    expect(
      encodeGoYaml(
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
    const spec = goMap(goString);
    expect(
      encodeGoYaml(
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
    const spec = goStruct([["t", goTime, "T"]]);
    // time's `parseNanoseconds` keeps at most 9 fractional digits (truncation,
    // not rounding), then RFC3339Nano trims trailing zeros.
    expect(encodeGoYaml({ t: "2026-01-01T00:00:00.1234567895Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789Z\n",
    );
    expect(encodeGoYaml({ t: "2026-01-01T00:00:00.12345678901234Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789Z\n",
    );
    expect(encodeGoYaml({ t: "2026-01-01T00:00:00.9999999999Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.999999999Z\n",
    );
    expect(encodeGoYaml({ t: "2026-01-01T00:00:00.1000000005Z" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.1Z\n",
    );
    expect(encodeGoYaml({ t: "2026-01-01T00:00:00.1234567895+07:00" }, spec)).toBe(
      "t: 2026-01-01T00:00:00.123456789+07:00\n",
    );
  });

  it("escapes non-printable scalars with \\x/\\u/\\U like yaml.v3's emitter", () => {
    const spec = goMap(goString);
    expect(
      encodeGoYaml(
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

describe("goFieldName", () => {
  it("capitalizes snake_case tokens like oapi-codegen", () => {
    expect(goFieldName("api_key")).toBe("ApiKey");
    expect(goFieldName("metadata_xml")).toBe("MetadataXml");
    expect(goFieldName("parent_project_ref")).toBe("ParentProjectRef");
    expect(goFieldName("ezbr_sha256")).toBe("EzbrSha256");
  });

  it("capitalizes the first letter of camelCase tags", () => {
    expect(goFieldName("appliedSuccessfully")).toBe("AppliedSuccessfully");
    expect(goFieldName("currentConfig")).toBe("CurrentConfig");
  });
});

describe("goFormatFloat", () => {
  it("matches strconv.FormatFloat(f, 'g', -1, 64)", () => {
    expect(goFormatFloat(1, 64)).toBe("1");
    expect(goFormatFloat(123456, 64)).toBe("123456");
    expect(goFormatFloat(1000000, 64)).toBe("1e+06");
    expect(goFormatFloat(1234567, 64)).toBe("1.234567e+06");
    expect(goFormatFloat(0.5, 64)).toBe("0.5");
    expect(goFormatFloat(0.000001, 64)).toBe("1e-06");
    expect(goFormatFloat(0, 64)).toBe("0");
    expect(goFormatFloat(-2.5, 64)).toBe("-2.5");
  });

  it("rounds through float32 like Go's typed fields", () => {
    expect(goFormatFloat(16777217, 32)).toBe("1.6777216e+07");
    expect(goFormatFloat(78125, 32)).toBe("78125");
    expect(goFormatFloat(0.5, 32)).toBe("0.5");
  });

  it("breaks exact shortest-digit ties to even like Ryu, not half-up", () => {
    // 4249.03125 sits exactly between the two shortest 8-digit candidates;
    // strconv keeps the even final digit both downward and upward.
    expect(goFormatFloat(4249.03125, 32)).toBe("4249.0312");
    expect(goFormatFloat(4249.09375, 32)).toBe("4249.0938");
    expect(goFormatFloat(123456789, 32)).toBe("1.2345679e+08");
    expect(goFormatFloat(1048575.5, 32)).toBe("1.0485755e+06");
    expect(goFormatFloat(8388607.5, 32)).toBe("8.3886075e+06");
    // Boundaries: smallest subnormal, subnormal→normal edge, and max finite.
    expect(goFormatFloat(1.401298464324817e-45, 32)).toBe("1e-45");
    expect(goFormatFloat(1.1754943508222875e-38, 32)).toBe("1.1754944e-38");
    expect(goFormatFloat(3.4028234663852886e38, 32)).toBe("3.4028235e+38");
    expect(goFormatFloat(-4249.03125, 32)).toBe("-4249.0312");
  });
});
