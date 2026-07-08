import { describe, expect, it } from "vitest";

import {
  legacyRenderStatusPretty,
  legacyStatusColumnLayout,
  legacyStatusHeaderWidth,
  legacyWrapStatusLabel,
} from "./status.pretty.ts";
import type { LegacyStatusOutputNames } from "./status.values.ts";

// The renderer applies Go-parity ANSI styling via `legacy-colors.ts`, which
// no-ops on a real non-TTY stream but the vitest process presents its stderr
// as color-capable. Strip escapes so these assertions target the plain
// structural output — the golden contract per the port plan — not whichever
// TTY heuristic the test runner happens to report.
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

// Default (un-overridden) output names, matching `status.values.ts`'s
// `resolveOutputNames` with an empty override map — the KEYs the pretty
// renderer looks values up by.
const NAMES: LegacyStatusOutputNames = {
  apiUrl: "API_URL",
  restUrl: "REST_URL",
  graphqlUrl: "GRAPHQL_URL",
  storageS3Url: "STORAGE_S3_URL",
  mcpUrl: "MCP_URL",
  functionsUrl: "FUNCTIONS_URL",
  dbUrl: "DB_URL",
  studioUrl: "STUDIO_URL",
  mailpitUrl: "MAILPIT_URL",
  publishableKey: "PUBLISHABLE_KEY",
  secretKey: "SECRET_KEY",
  storageS3AccessKeyId: "S3_PROTOCOL_ACCESS_KEY_ID",
  storageS3SecretAccessKey: "S3_PROTOCOL_ACCESS_KEY_SECRET",
  storageS3Region: "S3_PROTOCOL_REGION",
};

const FULL_VALUES: Record<string, string> = {
  API_URL: "http://127.0.0.1:54321",
  REST_URL: "http://127.0.0.1:54321/rest/v1",
  GRAPHQL_URL: "http://127.0.0.1:54321/graphql/v1",
  STORAGE_S3_URL: "http://127.0.0.1:54321/storage/v1/s3",
  MCP_URL: "http://127.0.0.1:54321/mcp",
  FUNCTIONS_URL: "http://127.0.0.1:54321/functions/v1",
  DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  STUDIO_URL: "http://127.0.0.1:54323",
  MAILPIT_URL: "http://127.0.0.1:54324",
  PUBLISHABLE_KEY: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH",
  SECRET_KEY: "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz",
  S3_PROTOCOL_ACCESS_KEY_ID: "625729a08b95bf1b7ff351a663f3a23c",
  S3_PROTOCOL_ACCESS_KEY_SECRET: "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
  S3_PROTOCOL_REGION: "local",
};

describe("legacyRenderStatusPretty", () => {
  // Byte-for-byte parity with a real `tablewriter@v1.1.4` + `tw.StyleRounded`
  // render of Go's `PrettyPrint` group layout (verified by running the actual
  // vendored Go module against this exact value set — see the port plan).
  it("matches the Go rounded-table fixture for a fully running stack", () => {
    const out = stripAnsi(legacyRenderStatusPretty(FULL_VALUES, NAMES));

    const expected = [
      "╭──────────────────────────────────────╮",
      "│ 🔧 Development Tools                 │",
      "├─────────┬────────────────────────────┤",
      "│ Studio  │ http://127.0.0.1:54323     │",
      "│ Mailpit │ http://127.0.0.1:54324     │",
      "│ MCP     │ http://127.0.0.1:54321/mcp │",
      "╰─────────┴────────────────────────────╯",
      "",
      "╭──────────────────────────────────────────────────────╮",
      "│ 🌐 APIs                                              │",
      "├────────────────┬─────────────────────────────────────┤",
      "│ Project URL    │ http://127.0.0.1:54321              │",
      "│ REST           │ http://127.0.0.1:54321/rest/v1      │",
      "│ GraphQL        │ http://127.0.0.1:54321/graphql/v1   │",
      "│ Edge Functions │ http://127.0.0.1:54321/functions/v1 │",
      "╰────────────────┴─────────────────────────────────────╯",
      "",
      "╭───────────────────────────────────────────────────────────────╮",
      "│ ⛁ Database                                                    │",
      "├─────┬─────────────────────────────────────────────────────────┤",
      "│ URL │ postgresql://postgres:postgres@127.0.0.1:54322/postgres │",
      "╰─────┴─────────────────────────────────────────────────────────╯",
      "",
      "╭──────────────────────────────────────────────────────────────╮",
      "│ 🔑 Authentication Keys                                       │",
      "├─────────────┬────────────────────────────────────────────────┤",
      "│ Publishable │ sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH │",
      "│ Secret      │ sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz      │",
      "╰─────────────┴────────────────────────────────────────────────╯",
      "",
      "╭───────────────────────────────────────────────────────────────────────────────╮",
      "│ 📦 Storage (S3)                                                               │",
      "├────────────┬──────────────────────────────────────────────────────────────────┤",
      "│ URL        │ http://127.0.0.1:54321/storage/v1/s3                             │",
      "│ Access Key │ 625729a08b95bf1b7ff351a663f3a23c                                 │",
      "│ Secret Key │ 850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907 │",
      "│ Region     │ local                                                            │",
      "╰────────────┴──────────────────────────────────────────────────────────────────╯",
      "",
    ].join("\n");

    expect(out).toBe(expected);
  });

  // Byte-for-byte parity with a real render of a single-row group (Database),
  // confirming the header-vs-single-short-row column sizing. All other groups
  // are empty in this fixture, so only the Database box should appear.
  it("matches the Go rounded-table fixture for a single-row group", () => {
    const out = stripAnsi(
      legacyRenderStatusPretty({ DB_URL: FULL_VALUES.DB_URL ?? "" }, { ...NAMES, dbUrl: "DB_URL" }),
    );

    const expectedTable = [
      "╭───────────────────────────────────────────────────────────────╮",
      "│ ⛁ Database                                                    │",
      "├─────┬─────────────────────────────────────────────────────────┤",
      "│ URL │ postgresql://postgres:postgres@127.0.0.1:54322/postgres │",
      "╰─────┴─────────────────────────────────────────────────────────╯",
    ].join("\n");

    expect(out).toContain(expectedTable);
    expect(out).toBe(["", "", expectedTable, "", "", ""].join("\n"));
  });

  // All other groups are empty in this fixture, so only the APIs box appears
  // (only Project URL, the rest of the group's rows are excluded/disabled).
  it("matches the Go rounded-table fixture for a partial APIs group", () => {
    const out = stripAnsi(legacyRenderStatusPretty({ API_URL: "http://127.0.0.1:54321" }, NAMES));

    const expectedTable = [
      "╭──────────────────────────────────────╮",
      "│ 🌐 APIs                              │",
      "├─────────────┬────────────────────────┤",
      "│ Project URL │ http://127.0.0.1:54321 │",
      "╰─────────────┴────────────────────────╯",
    ].join("\n");

    expect(out).toBe(["", expectedTable, "", "", "", ""].join("\n"));
  });

  it("skips a row whose value is missing from the value map", () => {
    // Only Studio present; Mailpit/MCP absent from the map entirely (excluded
    // or disabled upstream in `status.values.ts`) — same as an empty string.
    const out = stripAnsi(
      legacyRenderStatusPretty({ STUDIO_URL: "http://127.0.0.1:54323" }, NAMES),
    );

    expect(out).toContain("Studio");
    expect(out).not.toContain("Mailpit");
    expect(out).not.toContain("MCP");
  });

  it("skips an entirely empty group but still emits its trailing blank line", () => {
    // Nothing present for Development Tools; only the Database URL is set.
    const out = stripAnsi(legacyRenderStatusPretty({ DB_URL: FULL_VALUES.DB_URL ?? "" }, NAMES));
    const lines = out.split("\n");

    // No rounded-box characters before the Database group's own box.
    expect(lines[0]).not.toMatch(/[╭│╰]/);
    expect(lines[0]).toBe("");
    expect(out).not.toContain("Development Tools");
    expect(out).toContain("⛁ Database");
  });

  it("returns only blank lines when every group is empty", () => {
    const out = stripAnsi(legacyRenderStatusPretty({}, NAMES));
    // One blank line per group (5 groups), none of them rendering a table.
    expect(out).toBe(["", "", "", "", ""].join("\n"));
  });

  // `legacyRenderStatusPretty` is a pure lookup: it renders whatever `values`
  // are reachable through `names`' keys, with no opinion on how the caller
  // derived either. This is NOT asserting that `--override-name` reaches
  // pretty-mode output in production — `status.handler.ts` deliberately always
  // calls this function with un-overridden names (matching Go's `PrettyPrint`,
  // which unmarshals a fresh empty `EnvSet{}` rather than the CLI's overridden
  // `CustomName`). This test only proves the renderer's KEY-based lookup itself
  // works correctly for an arbitrary names/values pairing.
  it("resolves values through whatever KEY the names parameter specifies", () => {
    const overriddenNames: LegacyStatusOutputNames = {
      ...NAMES,
      apiUrl: "NEXT_PUBLIC_SUPABASE_URL",
    };
    const out = stripAnsi(
      legacyRenderStatusPretty(
        { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" },
        overriddenNames,
      ),
    );
    expect(out).toContain("http://127.0.0.1:54321");
  });
});

// None of `status`'s 18 fixed field labels or 5 fixed group titles are wide
// enough to exercise these two branches through the public
// `legacyRenderStatusPretty` API today (see the file-level doc comment on
// `status.pretty.ts`) — covered directly here as defensive Go-parity logic.
describe("legacyWrapStatusLabel", () => {
  it("returns the text unwrapped when it fits within the width", () => {
    expect(legacyWrapStatusLabel("Edge Functions", 16)).toEqual(["Edge Functions"]);
  });

  it("word-wraps a label wider than the column width", () => {
    expect(legacyWrapStatusLabel("This Is A Very Long Label Name", 16)).toEqual([
      "This Is A Very",
      "Long Label Name",
    ]);
  });

  it("hard-breaks a single word wider than the column width", () => {
    expect(legacyWrapStatusLabel("ThisIsAVeryLongSingleWordLabel", 16)).toEqual([
      "ThisIsAVeryLongSingleWordLabel",
    ]);
  });

  it("does not emit a leading empty line when the very first word already overflows", () => {
    expect(legacyWrapStatusLabel("SuperLongFirstWord Short", 10)).toEqual([
      "SuperLongFirstWord",
      "Short",
    ]);
  });

  it("returns the input unchanged for an empty label", () => {
    expect(legacyWrapStatusLabel("", 10)).toEqual([""]);
  });

  it("returns the input unchanged for a whitespace-only label wider than the column", () => {
    // Every "word" from splitting on spaces is itself empty, so `current` never
    // accumulates anything to flush after the loop — the `lines` array stays
    // empty and the function falls back to the original text.
    expect(legacyWrapStatusLabel("     ", 2)).toEqual(["     "]);
  });
});

describe("legacyStatusColumnLayout", () => {
  it("sizes columns from content alone when the header already fits", () => {
    const layout = legacyStatusColumnLayout(10, ["URL"], ["postgresql://short"]);
    expect(layout.targetInner).toBe(3 + 2 + 1 + "postgresql://short".length + 2);
  });

  it("widens both columns evenly when the header is wider than the data", () => {
    // Base data-driven layout: col0="a"(1+2=3), col1="b"(1+2=3), dataInner=3+1+3=7.
    // A 10-char header needs innerWidth=12, so 5 extra columns split 3/2.
    const layout = legacyStatusColumnLayout(10, ["a"], ["b"]);
    expect(layout.targetInner).toBe(12);
    expect(layout.col0Padded).toBe(6);
    expect(layout.col1Padded).toBe(5);
  });

  it("caps column 0's content width at 16 even when a label is longer", () => {
    const layout = legacyStatusColumnLayout(0, ["a".repeat(30)], ["b"]);
    expect(layout.col0Padded).toBe(18);
  });
});

describe("legacyStatusHeaderWidth", () => {
  it("uses the hardcoded emoji-aware width for a known fixed group title", () => {
    expect(legacyStatusHeaderWidth("⛁ Database")).toBe(10);
  });

  it("falls back to code-point length for a title outside the fixed table", () => {
    expect(legacyStatusHeaderWidth("Plain Title")).toBe("Plain Title".length);
  });
});
