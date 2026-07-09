import { describe, expect, it } from "vitest";

import { LEGACY_START_EXCLUDABLE_KEYS, legacyPartitionStartExcludeFlags } from "./start.exclude.ts";

// The warning applies Go-parity ANSI styling via `legacy-colors.ts`, which
// no-ops on a real non-TTY stream but the vitest process presents its stderr
// as color-capable. Strip escapes so these assertions target the plain text
// content — matching `status.pretty.unit.test.ts`'s convention.
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

// Go's `ExcludableContainers()` order (`apps/cli-go/internal/start/start.go:
// 1297-1303` walking `config.Images.Services()`,
// `apps/cli-go/pkg/config/constants.go:60-76`), expressed as the exact
// `--exclude` values Go's `utils.ShortContainerImageName` produces for each.
const EXPECTED_ORDER = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
];

describe("LEGACY_START_EXCLUDABLE_KEYS", () => {
  it("matches Go's ExcludableContainers() order exactly", () => {
    expect(LEGACY_START_EXCLUDABLE_KEYS).toEqual(EXPECTED_ORDER);
  });

  it("has exactly 13 entries with no duplicates", () => {
    expect(LEGACY_START_EXCLUDABLE_KEYS).toHaveLength(13);
    expect(new Set(LEGACY_START_EXCLUDABLE_KEYS).size).toBe(13);
  });

  it("never includes db/postgres — Postgres has no excludeKey in Go", () => {
    expect(LEGACY_START_EXCLUDABLE_KEYS).not.toContain("db");
    expect(LEGACY_START_EXCLUDABLE_KEYS).not.toContain("postgres");
  });
});

describe("legacyPartitionStartExcludeFlags", () => {
  it("treats every excludable key as valid with no warning", () => {
    const result = legacyPartitionStartExcludeFlags(EXPECTED_ORDER);
    expect(result.valid).toEqual(EXPECTED_ORDER);
    expect(result.invalid).toEqual([]);
    expect(result.warning).toBeUndefined();
  });

  it("returns no warning for an empty --exclude list", () => {
    const result = legacyPartitionStartExcludeFlags([]);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(result.warning).toBeUndefined();
  });

  it("treats db/postgres as invalid, matching Go", () => {
    const result = legacyPartitionStartExcludeFlags(["db", "postgres"]);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual(["db", "postgres"]);
    expect(result.warning).toBeDefined();
  });

  it("partitions valid and invalid values, preserving input order", () => {
    const result = legacyPartitionStartExcludeFlags(["kong", "bogus", "gotrue", "nope"]);
    expect(result.valid).toEqual(["kong", "gotrue"]);
    expect(result.invalid).toEqual(["bogus", "nope"]);
  });

  it("produces Go's exact WARNING: text, with the valid list alphabetically sorted", () => {
    const result = legacyPartitionStartExcludeFlags(["bogus"]);
    const sortedValid = [...EXPECTED_ORDER].sort();
    expect(stripAnsi(result.warning ?? "")).toBe(
      "WARNING: The following container names are not valid to exclude: bogus\n" +
        `Valid containers to exclude are: ${sortedValid.join(", ")}\n`,
    );
  });

  it("joins multiple invalid values with ', ' in input order", () => {
    const result = legacyPartitionStartExcludeFlags(["zeta", "alpha"]);
    expect(stripAnsi(result.warning ?? "")).toContain(
      "The following container names are not valid to exclude: zeta, alpha\n",
    );
  });
});
