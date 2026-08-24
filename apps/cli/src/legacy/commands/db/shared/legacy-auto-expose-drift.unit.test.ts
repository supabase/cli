import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { LEGACY_START_REVOKE_API_PRIVILEGES_SQL } from "../../../shared/db-bootstrap/db-setup.ts";
import {
  LEGACY_GRANT_DEFAULT_API_PRIVILEGES_SQL,
  legacyAutoExposeDriftWarning,
  legacyParseAutoExposeProbeRows,
} from "./legacy-auto-expose-drift.ts";

describe("legacyParseAutoExposeProbeRows", () => {
  it("reads a boolean probe row", () => {
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: true }])).toEqual(Option.some(true));
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: false }])).toEqual(Option.some(false));
  });

  it("tolerates a driver returning Postgres bool text", () => {
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: "t" }])).toEqual(Option.some(true));
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: "true" }])).toEqual(Option.some(true));
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: "f" }])).toEqual(Option.some(false));
    expect(legacyParseAutoExposeProbeRows([{ auto_expose: "false" }])).toEqual(Option.some(false));
  });

  it("resolves any unexpected shape to None so the warning is skipped", () => {
    expect(Option.isNone(legacyParseAutoExposeProbeRows([]))).toBe(true);
    expect(Option.isNone(legacyParseAutoExposeProbeRows([{}]))).toBe(true);
    expect(Option.isNone(legacyParseAutoExposeProbeRows([{ auto_expose: 1 }]))).toBe(true);
    expect(Option.isNone(legacyParseAutoExposeProbeRows([{ auto_expose: null }]))).toBe(true);
  });
});

describe("legacyAutoExposeDriftWarning", () => {
  it("stays silent when the effective local value matches the remote", () => {
    expect(
      legacyAutoExposeDriftWarning({
        localAutoExpose: Option.some(true),
        remoteAutoExpose: true,
      }),
    ).toBeUndefined();
    expect(
      legacyAutoExposeDriftWarning({
        localAutoExpose: Option.some(false),
        remoteAutoExpose: false,
      }),
    ).toBeUndefined();
    // Unset means revoke since the 2026-05-30 flip, so it matches a revoked remote.
    expect(
      legacyAutoExposeDriftWarning({ localAutoExpose: Option.none(), remoteAutoExpose: false }),
    ).toBeUndefined();
  });

  it("suggests a revoke migration first when the remote auto-exposes and local is unset", () => {
    const warning = legacyAutoExposeDriftWarning({
      localAutoExpose: Option.none(),
      remoteAutoExpose: true,
    });
    expect(warning).toContain(
      "WARNING: auto_expose_new_tables is enabled on the linked project but unset (treated as disabled) in your local config.",
    );
    expect(warning).toContain("supabase migration new disable_auto_expose_new_tables");
    expect(warning).toContain(LEGACY_START_REVOKE_API_PRIVILEGES_SQL);
    // The deprecated config opt-out is offered second, as the temporary alternative.
    expect(warning).toContain("set api.auto_expose_new_tables = true in supabase/config.toml");
    const migrationIndex = warning?.indexOf("supabase migration new") ?? -1;
    const configIndex = warning?.indexOf("api.auto_expose_new_tables = true") ?? -1;
    expect(migrationIndex).toBeGreaterThanOrEqual(0);
    expect(migrationIndex).toBeLessThan(configIndex);
  });

  it("names an explicit false instead of the unset wording", () => {
    const warning = legacyAutoExposeDriftWarning({
      localAutoExpose: Option.some(false),
      remoteAutoExpose: true,
    });
    expect(warning).toContain(
      "WARNING: auto_expose_new_tables is enabled on the linked project but disabled in your local config.",
    );
    expect(warning).not.toContain("unset");
  });

  it("suggests removing the config value or a grant migration when only local auto-exposes", () => {
    const warning = legacyAutoExposeDriftWarning({
      localAutoExpose: Option.some(true),
      remoteAutoExpose: false,
    });
    expect(warning).toContain(
      "WARNING: auto_expose_new_tables is disabled on the linked project but enabled in your local config.",
    );
    expect(warning).toContain("remove api.auto_expose_new_tables = true from supabase/config.toml");
    expect(warning).toContain("supabase migration new enable_auto_expose_new_tables");
    expect(warning).toContain(LEGACY_GRANT_DEFAULT_API_PRIVILEGES_SQL);
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
