import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../tests/helpers/ansi.ts";
import {
  renderStatusPretty,
  statusColumnLayout,
  statusHeaderWidth,
  wrapStatusLabel,
} from "./status-pretty.ts";
import type { StatusOutputNames } from "./status-values.ts";

// Default (un-overridden) output names — the keys the pretty renderer looks values up by.
const NAMES: StatusOutputNames = {
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

describe("renderStatusPretty", () => {
  it("matches the Go rounded-table fixture for a fully running stack", () => {
    const out = stripAnsi(renderStatusPretty(FULL_VALUES, NAMES));

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

  // All other groups are empty in this fixture, so only the Database box should appear.
  it("matches the Go rounded-table fixture for a single-row group", () => {
    const out = stripAnsi(
      renderStatusPretty({ DB_URL: FULL_VALUES.DB_URL ?? "" }, { ...NAMES, dbUrl: "DB_URL" }),
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

  // All other groups are empty in this fixture; only Project URL is present in APIs.
  it("matches the Go rounded-table fixture for a partial APIs group", () => {
    const out = stripAnsi(renderStatusPretty({ API_URL: "http://127.0.0.1:54321" }, NAMES));

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
    const out = stripAnsi(renderStatusPretty({ STUDIO_URL: "http://127.0.0.1:54323" }, NAMES));

    expect(out).toContain("Studio");
    expect(out).not.toContain("Mailpit");
    expect(out).not.toContain("MCP");
  });

  it("skips an entirely empty group but still emits its trailing blank line", () => {
    // Nothing present for Development Tools; only the Database URL is set.
    const out = stripAnsi(renderStatusPretty({ DB_URL: FULL_VALUES.DB_URL ?? "" }, NAMES));
    const lines = out.split("\n");

    expect(lines[0]).not.toMatch(/[╭│╰]/);
    expect(lines[0]).toBe("");
    expect(out).not.toContain("Development Tools");
    expect(out).toContain("⛁ Database");
  });

  it("returns only blank lines when every group is empty", () => {
    const out = stripAnsi(renderStatusPretty({}, NAMES));
    // One blank line per group (5 groups), none of them rendering a table.
    expect(out).toBe(["", "", "", "", ""].join("\n"));
  });

  // This is not asserting that `--override-name` reaches pretty-mode output in production —
  // `status.handler.ts` always calls this function with un-overridden names. It only proves
  // the renderer's key-based lookup works for an arbitrary names/values pairing.
  it("resolves values through whatever KEY the names parameter specifies", () => {
    const overriddenNames: StatusOutputNames = {
      ...NAMES,
      apiUrl: "NEXT_PUBLIC_SUPABASE_URL",
    };
    const out = stripAnsi(
      renderStatusPretty({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, overriddenNames),
    );
    expect(out).toContain("http://127.0.0.1:54321");
  });
});

// No fixed label or group title is wide enough to exercise these branches through the
// public `renderStatusPretty` API today — covered directly here instead.
describe("wrapStatusLabel", () => {
  it("returns the text unwrapped when it fits within the width", () => {
    expect(wrapStatusLabel("Edge Functions", 16)).toEqual(["Edge Functions"]);
  });

  it("word-wraps a label wider than the column width", () => {
    expect(wrapStatusLabel("This Is A Very Long Label Name", 16)).toEqual([
      "This Is A Very",
      "Long Label Name",
    ]);
  });

  it("hard-breaks a single word wider than the column width", () => {
    expect(wrapStatusLabel("ThisIsAVeryLongSingleWordLabel", 16)).toEqual([
      "ThisIsAVeryLongSingleWordLabel",
    ]);
  });

  it("does not emit a leading empty line when the very first word already overflows", () => {
    expect(wrapStatusLabel("SuperLongFirstWord Short", 10)).toEqual([
      "SuperLongFirstWord",
      "Short",
    ]);
  });

  it("returns the input unchanged for an empty label", () => {
    expect(wrapStatusLabel("", 10)).toEqual([""]);
  });

  it("returns the input unchanged for a whitespace-only label wider than the column", () => {
    expect(wrapStatusLabel("     ", 2)).toEqual(["     "]);
  });
});

describe("statusColumnLayout", () => {
  it("sizes columns from content alone when the header already fits", () => {
    const layout = statusColumnLayout(10, ["URL"], ["postgresql://short"]);
    expect(layout.targetInner).toBe(3 + 2 + 1 + "postgresql://short".length + 2);
  });

  it("widens both columns evenly when the header is wider than the data", () => {
    // col0="a" (1+2=3), col1="b" (1+2=3), dataInner=7; a 10-char header needs innerWidth=12,
    // so 5 extra columns split 3/2.
    const layout = statusColumnLayout(10, ["a"], ["b"]);
    expect(layout.targetInner).toBe(12);
    expect(layout.col0Padded).toBe(6);
    expect(layout.col1Padded).toBe(5);
  });

  it("caps column 0's content width at 16 even when a label is longer", () => {
    const layout = statusColumnLayout(0, ["a".repeat(30)], ["b"]);
    expect(layout.col0Padded).toBe(18);
  });
});

describe("statusHeaderWidth", () => {
  it("uses the hardcoded emoji-aware width for a known fixed group title", () => {
    expect(statusHeaderWidth("⛁ Database")).toBe(10);
  });

  it("falls back to code-point length for a title outside the fixed table", () => {
    expect(statusHeaderWidth("Plain Title")).toBe("Plain Title".length);
  });
});
