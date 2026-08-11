import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import {
  LEGACY_PGADMIN_DESKTOP_NOTE_PREFIX,
  LEGACY_PGADMIN_DIFF_HEADER,
  legacyProcessPgAdminDiffOutput,
  legacyProcessPgAdminDiffProgress,
} from "./legacy-pgadmin-diff.ts";

/** Go's `DiffEntry` (`container_output.go:127-134`) shape, defaulting to a kept entry. */
function entry(overrides: Record<string, unknown> = {}) {
  return {
    type: "table",
    status: "Different",
    diff_ddl: "ALTER TABLE test;",
    group_name: "public",
    ...overrides,
  };
}

const headerPlus = (ddl: string) => `${LEGACY_PGADMIN_DIFF_HEADER}\n\n${ddl}\n`;

describe("legacyProcessPgAdminDiffOutput", () => {
  describe("filtering rules (container_output.go:154-195)", () => {
    it("keeps DDL from every whitelisted entry type, joined under the exact 4-line pgAdmin header", () => {
      // Go test parity: `TestProcessDiffOutput/processes valid diff entries`.
      const types = ["extension", "function", "mview", "table", "trigger_function", "type", "view"];
      const entries = types.map((type, i) => entry({ type, diff_ddl: `DDL_${i};` }));
      const result = legacyProcessPgAdminDiffOutput(JSON.stringify(entries));
      const expectedDdls = types.map((_, i) => `DDL_${i};`).join("\n\n");
      expect(result).toEqual(Result.succeed(headerPlus(expectedDdls)));
    });

    it("skips an entry whose status is Identical, even with a non-empty diff_ddl", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ status: "Identical" })]),
      );
      expect(result).toEqual(Result.succeed(""));
    });

    it("skips an entry whose diff_ddl is empty", () => {
      const result = legacyProcessPgAdminDiffOutput(JSON.stringify([entry({ diff_ddl: "" })]));
      expect(result).toEqual(Result.succeed(""));
    });

    it("skips an entry whose diff_ddl is only whitespace after Go's TrimSpace", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ diff_ddl: "   \n\t  " })]),
      );
      expect(result).toEqual(Result.succeed(""));
    });

    it("skips entries whose type is outside the pgAdmin allow-list (e.g. sequence, index)", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ type: "sequence" }), entry({ type: "index" })]),
      );
      expect(result).toEqual(Result.succeed(""));
    });

    it('skips an entry with no type field at all, given a non-empty diff_ddl (defaults to "", outside the allow-list)', () => {
      // Distinct from the `[{"unknown":1}]` acceptance-rule case below, whose empty
      // `diff_ddl` short-circuits at the PRIOR `status === "Identical" || diff_ddl === ""`
      // check — this covers the `type` fallback itself.
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([
          { status: "Different", diff_ddl: "ALTER TABLE test;", group_name: "public" },
        ]),
      );
      expect(result).toEqual(Result.succeed(""));
    });

    it("keeps an entry with no group_name field at all (empty group name is not an internal schema)", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([{ type: "table", status: "Different", diff_ddl: "ALTER TABLE test;" }]),
      );
      expect(result).toEqual(Result.succeed(headerPlus("ALTER TABLE test;")));
    });

    it("skips an entry when any dependency has type extension", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ dependencies: [{ type: "table" }, { type: "extension" }] })]),
      );
      expect(result).toEqual(Result.succeed(""));
    });

    it("keeps an entry whose dependencies are all non-extension types", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ dependencies: [{ type: "table" }, { type: "view" }] })]),
      );
      expect(result).toEqual(Result.succeed(headerPlus("ALTER TABLE test;")));
    });

    it("skips an entry whose group_name is an internal schema (auth)", () => {
      // Go test parity: `TestProcessDiffOutput/filters out internal schemas`.
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ group_name: "auth" })]),
      );
      expect(result).toEqual(Result.succeed(""));
    });

    it("skips a trigger_function entry whose source_schema_name is an internal schema", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([
          entry({ type: "trigger_function", group_name: "public", source_schema_name: "auth" }),
        ]),
      );
      expect(result).toEqual(Result.succeed(""));
    });

    it("keeps group_name pg_catalog — internal-schema filtering is exact-string, not a pg_* glob", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ group_name: "pg_catalog" })]),
      );
      expect(result).toEqual(Result.succeed(headerPlus("ALTER TABLE test;")));
    });

    it("trims each kept DDL with Go's TrimSpace before joining", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ diff_ddl: "  ALTER TABLE test;  \n" })]),
      );
      expect(result).toEqual(Result.succeed(headerPlus("ALTER TABLE test;")));
    });
  });

  describe("empty / DESKTOP-mode-prefix handling (container_output.go:141-147)", () => {
    it("returns an empty string for an entirely empty buffer", () => {
      expect(legacyProcessPgAdminDiffOutput("")).toEqual(Result.succeed(""));
    });

    it("trims the DESKTOP-mode NOTE prefix from the front of the buffer before parsing", () => {
      const payload = LEGACY_PGADMIN_DESKTOP_NOTE_PREFIX + JSON.stringify([entry()]);
      expect(legacyProcessPgAdminDiffOutput(payload)).toEqual(
        Result.succeed(headerPlus("ALTER TABLE test;")),
      );
    });

    it("returns an empty string when the buffer is only the DESKTOP-mode NOTE prefix", () => {
      expect(legacyProcessPgAdminDiffOutput(LEGACY_PGADMIN_DESKTOP_NOTE_PREFIX)).toEqual(
        Result.succeed(""),
      );
    });

    it("does not trim the DESKTOP-mode NOTE prefix when it isn't at the very front (Go's bytes.TrimPrefix is front-anchored only)", () => {
      const payload = `[]${LEGACY_PGADMIN_DESKTOP_NOTE_PREFIX}`;
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput(payload))).toBe(true);
    });
  });

  // Go-acceptance-rules table (`json.Unmarshal` into `[]DiffEntry`, `container_output.go:127-134`),
  // verified against Go 1.26 `encoding/json`.
  describe("Go encoding/json acceptance rules", () => {
    it("treats a top-level JSON null the same as Go's nil-slice no-op", () => {
      expect(legacyProcessPgAdminDiffOutput("null")).toEqual(Result.succeed(""));
    });

    it("returns an empty string for an empty array", () => {
      expect(legacyProcessPgAdminDiffOutput("[]")).toEqual(Result.succeed(""));
    });

    it("accepts a null array element (Go unmarshals it into the zero-valued struct) and skips it", () => {
      expect(legacyProcessPgAdminDiffOutput("[null]")).toEqual(Result.succeed(""));
    });

    it.each(["{}", '"x"', "1", "true"])(
      "rejects a non-array top-level JSON value (%s)",
      (payload) => {
        expect(Result.isFailure(legacyProcessPgAdminDiffOutput(payload))).toBe(true);
      },
    );

    it("rejects an array whose element is neither an object nor null (e.g. a bare number)", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput("[1]"))).toBe(true);
    });

    it("rejects an array whose element is neither an object nor null (e.g. a bare string)", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput('["x"]'))).toBe(true);
    });

    it("rejects an array element that is itself an array", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput("[[]]"))).toBe(true);
    });

    it("accepts an unknown field and treats the entry as if absent, skipping it", () => {
      expect(legacyProcessPgAdminDiffOutput('[{"unknown":1}]')).toEqual(Result.succeed(""));
    });

    it("treats a null status field as absent, not as Identical", () => {
      const result = legacyProcessPgAdminDiffOutput(JSON.stringify([entry({ status: null })]));
      expect(result).toEqual(Result.succeed(headerPlus("ALTER TABLE test;")));
    });

    it("treats a null dependencies field as absent (no dependency filtering applied)", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ dependencies: null })]),
      );
      expect(result).toEqual(Result.succeed(headerPlus("ALTER TABLE test;")));
    });

    it("accepts a null dependency element and does not treat it as an extension dependency", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ dependencies: [null] })]),
      );
      expect(result).toEqual(Result.succeed(headerPlus("ALTER TABLE test;")));
    });

    it("rejects a dependencies array whose element is itself an array", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput('[{"dependencies":[[]]}]'))).toBe(
        true,
      );
    });

    it("treats a null source_schema_name field as absent (not internal-schema-filtered)", () => {
      const result = legacyProcessPgAdminDiffOutput(
        JSON.stringify([entry({ source_schema_name: null })]),
      );
      expect(result).toEqual(Result.succeed(headerPlus("ALTER TABLE test;")));
    });

    it("rejects a mistyped type field (number instead of string)", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput('[{"type":123}]'))).toBe(true);
    });

    it("rejects a mistyped status field (number instead of string)", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput('[{"status":123}]'))).toBe(true);
    });

    it("rejects a mistyped diff_ddl field (number instead of string)", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput('[{"diff_ddl":123}]'))).toBe(true);
    });

    it("rejects a mistyped group_name field (number instead of string)", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput('[{"group_name":123}]'))).toBe(true);
    });

    it("rejects a mistyped source_schema_name field (number instead of string)", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput('[{"source_schema_name":123}]'))).toBe(
        true,
      );
    });

    it("rejects a dependencies field that isn't an array", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput('[{"dependencies":{}}]'))).toBe(true);
    });

    it("rejects a dependencies array whose element isn't an object or null (e.g. a number)", () => {
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput('[{"dependencies":[1]}]'))).toBe(true);
    });

    it("rejects a dependency element with a mistyped type field", () => {
      expect(
        Result.isFailure(legacyProcessPgAdminDiffOutput('[{"dependencies":[{"type":1}]}]')),
      ).toBe(true);
    });

    it("accepts trailing whitespace after the JSON array", () => {
      const result = legacyProcessPgAdminDiffOutput(`${JSON.stringify([entry()])}\n  \n`);
      expect(result).toEqual(Result.succeed(headerPlus("ALTER TABLE test;")));
    });

    it("rejects two concatenated JSON arrays — multi-schema runs share one buffer (TS-only: Go never parses, see DiffStream divergence)", () => {
      const payload = `${JSON.stringify([entry()])}${JSON.stringify([entry()])}`;
      expect(Result.isFailure(legacyProcessPgAdminDiffOutput(payload))).toBe(true);
    });
  });
});

describe("legacyProcessPgAdminDiffProgress", () => {
  it.each([
    ["Comparing Tables 45%", ["Comparing Tables "]],
    ["Diffing 100%", ["Diffing 1"]],
    // `container_output.go:96`'s real regexp and JS both produce group1="10",
    // group2="00" for "1000%" (verified against Go 1.26 `regexp`) — NOT ["1"].
    ["1000%", ["10"]],
    ["5%", []],
    ["Starting schema diff...", []],
    ["some random noise line", []],
    ["", []],
  ] as const)("%s => %j", (line, expected) => {
    expect(legacyProcessPgAdminDiffProgress(line)).toEqual(expected);
  });

  it("scans multiple lines and strips \\r\\n line endings before matching", () => {
    const input =
      "Starting schema diff...\r\nComparing Tables 45%\r\nnoise line\r\nDiffing 100%\r\n";
    expect(legacyProcessPgAdminDiffProgress(input)).toEqual(["Comparing Tables ", "Diffing 1"]);
  });

  it("still emits a match on the final line even without a trailing newline", () => {
    const input = "Starting schema diff...\nDiffing 100%";
    expect(legacyProcessPgAdminDiffProgress(input)).toEqual(["Diffing 1"]);
  });

  it("matches across embedded \\r within a single line (the `s`/dotAll flag, Go's RE2 . matches \\r)", () => {
    // A `\r`-driven progress bar overwrites the same terminal line with multiple
    // updates, none of them `\n`-terminated, so `legacyScanLines` treats the whole
    // thing as ONE line. With the `s` flag, `.` matches `\r` too, so the greedy
    // `(.*)` consumes across every embedded `\r` and the match is anchored on the
    // LAST `%`-suffixed run, same as Go's RE2 (verified against Go 1.26 `regexp`)
    // — not the first, which is what this pattern would wrongly match without `s`
    // (JS's `.` excludes `\r` by default).
    const input = "Comparing 10%\rComparing 20%\rComparing 30%";
    expect(legacyProcessPgAdminDiffProgress(input)).toEqual([
      "Comparing 10%\rComparing 20%\rComparing ",
    ]);
  });
});
