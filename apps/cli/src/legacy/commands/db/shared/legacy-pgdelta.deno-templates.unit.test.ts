import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

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
const readGoTemplate = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(goDiffTemplatesDir, name));
  });
const readPgDeltaTemplate = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(goPgDeltaTemplatesDir, name));
  });

describe("embedded pg-delta Deno templates", () => {
  it.effect("match the Go sources byte-for-byte", () =>
    Effect.gen(function* () {
      expect(legacyPgDeltaDiffScript).toBe(yield* readGoTemplate("pgdelta.ts"));
      expect(legacyPgDeltaDeclarativeExportScript).toBe(
        yield* readGoTemplate("pgdelta_declarative_export.ts"),
      );
      expect(legacyPgDeltaCatalogExportScript).toBe(
        yield* readGoTemplate("pgdelta_catalog_export.ts"),
      );
      expect(legacyPgDeltaDeclarativeApplyScript).toBe(
        yield* readPgDeltaTemplate("pgdelta_declarative_apply.ts"),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

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
