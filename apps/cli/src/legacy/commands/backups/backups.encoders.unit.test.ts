import { V1ListAllBackupsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "vitest";

import { encodeEnv, encodeGoJson, encodeToml, encodeYaml } from "./backups.encoders.ts";

const SAMPLE_RESPONSE: typeof V1ListAllBackupsOutput.Type = {
  region: "ap-southeast-1",
  walg_enabled: true,
  pitr_enabled: true,
  backups: [
    {
      id: 1,
      is_physical_backup: true,
      status: "COMPLETED",
      inserted_at: "2026-02-08T16:44:07Z",
    },
  ],
  physical_backup_data: {
    earliest_physical_backup_date_unix: 1700000000,
    latest_physical_backup_date_unix: 1700001000,
  },
};

describe("encodeGoJson", () => {
  it("emits Go's alphabetical struct-field order and trailing newline for a populated response", () => {
    const out = encodeGoJson(SAMPLE_RESPONSE);
    expect(out).toBe(
      `{
  "backups": [
    {
      "id": 1,
      "inserted_at": "2026-02-08T16:44:07Z",
      "is_physical_backup": true,
      "status": "COMPLETED"
    }
  ],
  "physical_backup_data": {
    "earliest_physical_backup_date_unix": 1700000000,
    "latest_physical_backup_date_unix": 1700001000
  },
  "pitr_enabled": true,
  "region": "ap-southeast-1",
  "walg_enabled": true
}
`,
    );
  });

  it("emits backups: null and an empty physical_backup_data object for a PITR-only response", () => {
    // Matches Go's `apps/cli-go/internal/backups/list/list_test.go` "encodes json output" fixture
    // — empty backups slice serializes as null, omitempty physical_backup_data fields drop out.
    const out = encodeGoJson({
      region: "ap-southeast-1",
      walg_enabled: false,
      pitr_enabled: false,
      backups: [],
      physical_backup_data: {},
    });
    expect(out).toBe(
      `{
  "backups": null,
  "physical_backup_data": {},
  "pitr_enabled": false,
  "region": "ap-southeast-1",
  "walg_enabled": false
}
`,
    );
  });
});

describe("encodeYaml", () => {
  it("renders nested objects as YAML", () => {
    const out = encodeYaml(SAMPLE_RESPONSE);
    expect(out).toContain("region: ap-southeast-1");
    expect(out).toContain("walg_enabled: true");
    expect(out).toContain("status: COMPLETED");
    expect(out).toContain("earliest_physical_backup_date_unix: 1700000000");
  });
});

describe("encodeToml", () => {
  it("renders a TOML document for the response", () => {
    const out = encodeToml(SAMPLE_RESPONSE);
    expect(out).toContain('region = "ap-southeast-1"');
    expect(out).toContain("walg_enabled = true");
    expect(out).toContain("[physical_backup_data]");
    expect(out).toContain("earliest_physical_backup_date_unix = 1700000000");
  });
});

describe("encodeEnv", () => {
  it("quotes string values and flattens nested fields to uppercased dotted keys", () => {
    const out = encodeEnv(SAMPLE_RESPONSE);
    const lines = out.split("\n");
    expect(lines).toContain('REGION="ap-southeast-1"');
    // Booleans are stringified to "true"/"false" — not integers under strconv.Atoi,
    // so godotenv quotes them.
    expect(lines).toContain('WALG_ENABLED="true"');
    expect(lines).toContain('PITR_ENABLED="true"');
  });

  it("emits integer-parseable values unquoted (matches godotenv strconv.Atoi branch)", () => {
    const out = encodeEnv(SAMPLE_RESPONSE);
    const lines = out.split("\n");
    expect(lines).toContain("PHYSICAL_BACKUP_DATA_EARLIEST_PHYSICAL_BACKUP_DATE_UNIX=1700000000");
    expect(lines).toContain("PHYSICAL_BACKUP_DATA_LATEST_PHYSICAL_BACKUP_DATE_UNIX=1700001000");
  });

  it("collapses arrays to a single empty leaf (Go viper does not descend into slices)", () => {
    // Go output for `backups: [{...}]` is `BACKUPS=""`, not `BACKUPS_0_STATUS=...`
    // — viper.AllKeys() stops at slice boundaries and GetString of a slice is "".
    const out = encodeEnv(SAMPLE_RESPONSE);
    const lines = out.split("\n");
    expect(lines).toContain('BACKUPS=""');
    expect(lines.some((line) => line.startsWith("BACKUPS_0_"))).toBe(false);
  });

  it("matches Go's full env output for the sample backup response", () => {
    // Verified byte-for-byte against `apps/cli-go` invoking utils.EncodeOutput("env", ...).
    expect(encodeEnv(SAMPLE_RESPONSE)).toBe(
      [
        'BACKUPS=""',
        "PHYSICAL_BACKUP_DATA_EARLIEST_PHYSICAL_BACKUP_DATE_UNIX=1700000000",
        "PHYSICAL_BACKUP_DATA_LATEST_PHYSICAL_BACKUP_DATE_UNIX=1700001000",
        'PITR_ENABLED="true"',
        'REGION="ap-southeast-1"',
        'WALG_ENABLED="true"',
      ].join("\n"),
    );
  });

  it("escapes embedded backslashes and double quotes", () => {
    const out = encodeEnv({ message: 'with "quotes" and \\backslash' });
    expect(out).toBe('MESSAGE="with \\"quotes\\" and \\\\backslash"');
  });

  it("sorts keys deterministically and emits numeric leafs without quotes", () => {
    const out = encodeEnv({ z: 1, a: 2, m: 3 });
    expect(out.split("\n")).toEqual(["A=2", "M=3", "Z=1"]);
  });

  it("omits empty nested maps entirely (Go viper parity)", () => {
    // Go output for `{physical_backup_data: {}}` is empty — viper.AllKeys()
    // does not surface a key for a map with no children. Contrast with empty
    // arrays, which Go DOES surface as `KEY=""`.
    expect(encodeEnv({ physical_backup_data: {} })).toBe("");
  });

  it("matches Go for the PITR-only response shape with empty physical_backup_data", () => {
    // Verified byte-for-byte against `apps/cli-go` invoking utils.EncodeOutput("env", ...)
    // with a JSON-decoded V1BackupsResponse whose physical_backup_data is `{}`.
    expect(
      encodeEnv({
        region: "ap-southeast-1",
        walg_enabled: true,
        pitr_enabled: true,
        backups: [],
        physical_backup_data: {},
      }),
    ).toBe(
      ['BACKUPS=""', 'PITR_ENABLED="true"', 'REGION="ap-southeast-1"', 'WALG_ENABLED="true"'].join(
        "\n",
      ),
    );
  });

  it("emits an empty-string value for an explicit null leaf", () => {
    // Go: viper does surface a nil leaf as `KEY=""` (it still has a key path).
    expect(encodeEnv({ physical_backup_data: { earliest_physical_backup_date_unix: null } })).toBe(
      'PHYSICAL_BACKUP_DATA_EARLIEST_PHYSICAL_BACKUP_DATE_UNIX=""',
    );
  });

  it("treats non-integer numeric strings as strings (quoted)", () => {
    const out = encodeEnv({ ratio: "3.14", empty: "" });
    const lines = out.split("\n");
    expect(lines).toContain('RATIO="3.14"');
    expect(lines).toContain('EMPTY=""');
  });

  it("handles negative integers unquoted", () => {
    const out = encodeEnv({ offset: -42 });
    expect(out).toBe("OFFSET=-42");
  });
});
