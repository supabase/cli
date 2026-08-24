// The warning's user-visible behavior (both drift directions, the silent match,
// probe failures, target gating) lives in `db diff`/`db pull`'s integration
// suites. This file covers only the pure edge cases that are awkward to reach
// through handlers: probe-row parsing leniency and the grant/revoke symmetry.

import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { LEGACY_START_REVOKE_API_PRIVILEGES_SQL } from "./db-bootstrap/db-setup.ts";
import {
  LEGACY_GRANT_DEFAULT_API_PRIVILEGES_SQL,
  legacyAutoExposeDriftWarning,
  legacyParseAutoExposeProbeRows,
} from "./legacy-auto-expose-drift.ts";

describe("legacyParseAutoExposeProbeRows", () => {
  it("reads boolean rows and tolerates Postgres bool text", () => {
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: true }])).toEqual(Option.some(true));
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: false }])).toEqual(Option.some(false));
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: "t" }])).toEqual(Option.some(true));
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: "f" }])).toEqual(Option.some(false));
  });

  it("resolves any unexpected shape to None so the warning is skipped", () => {
    expect(Option.isNone(legacyParseAutoExposeProbeRows([]))).toBe(true);
    expect(Option.isNone(legacyParseAutoExposeProbeRows([{}]))).toBe(true);
    expect(Option.isNone(legacyParseAutoExposeProbeRows([{ auto_expose: 1 }]))).toBe(true);
  });
});

describe("legacyAutoExposeDriftWarning", () => {
  it("names an explicit true instead of the unset wording", () => {
    const warning = legacyAutoExposeDriftWarning({
      localAutoExpose: Option.some(true),
      remoteAutoExpose: false,
    });
    expect(warning).toContain("but enabled in your local config");
    expect(warning).not.toContain("unset");
    // A matching explicit pair stays silent.
    expect(
      legacyAutoExposeDriftWarning({ localAutoExpose: Option.some(true), remoteAutoExpose: true }),
    ).toBeUndefined();
  });

  it("keeps the grant migration the exact inverse of the revoke migration", () => {
    expect(LEGACY_GRANT_DEFAULT_API_PRIVILEGES_SQL).toBe(
      LEGACY_START_REVOKE_API_PRIVILEGES_SQL.replaceAll("revoke", "grant").replaceAll(
        " from anon",
        " to anon",
      ),
    );
  });
});
