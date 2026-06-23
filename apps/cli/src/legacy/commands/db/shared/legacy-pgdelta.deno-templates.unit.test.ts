import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LEGACY_DEFAULT_PG_DELTA_NPM_VERSION,
  LEGACY_PG_DELTA_NPM_VERSION_PLACEHOLDER,
  legacyEffectivePgDeltaNpmVersion,
  legacyInterpolatePgDeltaScript,
  legacyPgDeltaCatalogExportScript,
  legacyPgDeltaDeclarativeApplyScript,
  legacyPgDeltaDeclarativeExportScript,
  legacyPgDeltaDiffScript,
} from "./legacy-pgdelta.deno-templates.ts";

// Resolve the Go template sources relative to this file so the byte-equality
// assertion fails loudly if the embedded copies drift from upstream.
const goDiffTemplatesDir = fileURLToPath(
  new URL("../../../../../../cli-go/internal/db/diff/templates/", import.meta.url),
);
const goPgDeltaTemplatesDir = fileURLToPath(
  new URL("../../../../../../cli-go/internal/pgdelta/templates/", import.meta.url),
);
const readGoTemplate = (name: string) => readFileSync(`${goDiffTemplatesDir}${name}`, "utf8");

describe("embedded pg-delta Deno templates", () => {
  it("match the Go sources byte-for-byte", () => {
    expect(legacyPgDeltaDiffScript).toBe(readGoTemplate("pgdelta.ts"));
    expect(legacyPgDeltaDeclarativeExportScript).toBe(
      readGoTemplate("pgdelta_declarative_export.ts"),
    );
    expect(legacyPgDeltaCatalogExportScript).toBe(readGoTemplate("pgdelta_catalog_export.ts"));
    expect(legacyPgDeltaDeclarativeApplyScript).toBe(
      readFileSync(`${goPgDeltaTemplatesDir}pgdelta_declarative_apply.ts`, "utf8"),
    );
  });

  it("pin the placeholder npm version that interpolation rewrites", () => {
    expect(legacyPgDeltaDiffScript).toContain(
      `npm:@supabase/pg-delta@${LEGACY_PG_DELTA_NPM_VERSION_PLACEHOLDER}`,
    );
    expect(legacyPgDeltaDeclarativeExportScript).toContain(
      `npm:@supabase/pg-delta@${LEGACY_PG_DELTA_NPM_VERSION_PLACEHOLDER}`,
    );
    expect(legacyPgDeltaCatalogExportScript).toContain(
      `npm:@supabase/pg-delta@${LEGACY_PG_DELTA_NPM_VERSION_PLACEHOLDER}`,
    );
  });
});

describe("legacyEffectivePgDeltaNpmVersion", () => {
  it("returns the default when the version is unset, empty, or whitespace", () => {
    expect(legacyEffectivePgDeltaNpmVersion(undefined)).toBe(LEGACY_DEFAULT_PG_DELTA_NPM_VERSION);
    expect(legacyEffectivePgDeltaNpmVersion("")).toBe(LEGACY_DEFAULT_PG_DELTA_NPM_VERSION);
    expect(legacyEffectivePgDeltaNpmVersion("   ")).toBe(LEGACY_DEFAULT_PG_DELTA_NPM_VERSION);
  });

  it("trims and returns a configured version", () => {
    expect(legacyEffectivePgDeltaNpmVersion("  1.2.3  ")).toBe("1.2.3");
  });
});

describe("legacyInterpolatePgDeltaScript", () => {
  it("rewrites every placeholder occurrence to the effective version", () => {
    const out = legacyInterpolatePgDeltaScript(legacyPgDeltaDiffScript, "9.9.9");
    expect(out).not.toContain(`npm:@supabase/pg-delta@${LEGACY_PG_DELTA_NPM_VERSION_PLACEHOLDER}`);
    expect(out).toContain("npm:@supabase/pg-delta@9.9.9");
    expect(out).toContain("npm:@supabase/pg-delta@9.9.9/integrations/supabase");
  });

  it("rewrites to the default version when unset", () => {
    const out = legacyInterpolatePgDeltaScript(legacyPgDeltaCatalogExportScript, undefined);
    expect(out).toContain(`npm:@supabase/pg-delta@${LEGACY_DEFAULT_PG_DELTA_NPM_VERSION}`);
  });
});
