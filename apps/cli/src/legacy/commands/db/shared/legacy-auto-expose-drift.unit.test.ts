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
    // Unset means grants kept, matching the platform's current default — so a fresh
    // project with an untouched config never warns.
    expect(
      legacyAutoExposeDriftWarning({ localAutoExpose: Option.none(), remoteAutoExpose: true }),
    ).toBeUndefined();
  });

  it("suggests a revoke migration first when only the local config disabled auto-expose", () => {
    const warning = legacyAutoExposeDriftWarning({
      localAutoExpose: Option.some(false),
      remoteAutoExpose: true,
    });
    expect(warning).toContain(
      "WARNING: auto_expose_new_tables is enabled on the linked project but disabled in your local config.",
    );
    // The explicit false says the user wants the revoked behaviour — the remote
    // should follow, so the migration leads and the config rollback is the fallback.
    expect(warning).toContain("supabase migration new disable_auto_expose_new_tables");
    expect(warning).toContain(LEGACY_START_REVOKE_API_PRIVILEGES_SQL);
    expect(warning).toContain(
      "remove api.auto_expose_new_tables = false from supabase/config.toml",
    );
    const migrationIndex = warning?.indexOf("supabase migration new") ?? -1;
    const configIndex = warning?.indexOf("api.auto_expose_new_tables = false") ?? -1;
    expect(migrationIndex).toBeGreaterThanOrEqual(0);
    expect(migrationIndex).toBeLessThan(configIndex);
  });

  it("suggests the config change first when only the remote disabled auto-expose", () => {
    const warning = legacyAutoExposeDriftWarning({
      localAutoExpose: Option.none(),
      remoteAutoExpose: false,
    });
    expect(warning).toContain(
      "WARNING: auto_expose_new_tables is disabled on the linked project but unset (treated as enabled) in your local config.",
    );
    // The remote already adopted the upcoming revoked default — the config should
    // follow, so setting false leads and the grant migration is the fallback.
    expect(warning).toContain("set api.auto_expose_new_tables = false in supabase/config.toml");
    expect(warning).toContain("supabase migration new enable_auto_expose_new_tables");
    expect(warning).toContain(LEGACY_GRANT_DEFAULT_API_PRIVILEGES_SQL);
    const configIndex = warning?.indexOf("api.auto_expose_new_tables = false") ?? -1;
    const migrationIndex = warning?.indexOf("supabase migration new") ?? -1;
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(configIndex).toBeLessThan(migrationIndex);
  });

  it("names an explicit true instead of the unset wording", () => {
    const warning = legacyAutoExposeDriftWarning({
      localAutoExpose: Option.some(true),
      remoteAutoExpose: false,
    });
    expect(warning).toContain(
      "WARNING: auto_expose_new_tables is disabled on the linked project but enabled in your local config.",
    );
    expect(warning).not.toContain("unset");
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
