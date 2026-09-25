import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  findLanguage,
  GENERATOR_METADATA_VERSION,
  type GeneratorMetadata,
  introspect,
  languages,
} from "@supabase/typegen";

const emptyMetadata: GeneratorMetadata = {
  version: GENERATOR_METADATA_VERSION,
  schemas: [{ id: 1, name: "public", owner: "postgres" }],
  tables: [],
  views: [],
  materializedViews: [],
  foreignTables: [],
  columns: [],
  primaryKeys: [],
  relationships: [],
  functions: [],
  types: [],
};

/** A host for in-process languages only: no process runner, TypeScript left unformatted. */
const inProcessHost = { cwd: "/tmp", env: {}, format: (code: string) => Promise.resolve(code) };

const readPackageJson = (
  dir: string,
): {
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
} => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/**
 * `tsconfig.types.json` type-checks `@supabase/postgrest-typegen` against its published
 * `dist/*.d.ts`, while Bun resolves the `bun` exports condition of both typegen packages to their
 * `src/*.ts` at runtime. These assertions run against the Bun-resolved modules, so a drift between
 * the two views fails here rather than at generation time.
 */
describe("typegen registry runtime contract", () => {
  it("exposes the registry and the re-exported introspection entry point", () => {
    expect(typeof introspect).toBe("function");
    expect(typeof findLanguage).toBe("function");
    expect(languages.map((language) => language.name)).toEqual(
      expect.arrayContaining(["typescript", "go", "python", "swift", "dart"]),
    );
  });

  it.effect("renders every in-process language from metadata alone", () =>
    Effect.gen(function* () {
      for (const language of languages.filter((language) => language.inProcess)) {
        const output = yield* Effect.promise(() =>
          language.generate(emptyMetadata, {}, inProcessHost),
        );
        expect(output.length, language.name).toBeGreaterThan(0);
      }
      expect(findLanguage("dart")?.inProcess).toBe(false);
    }),
  );

  /**
   * The CLI depends on `@supabase/postgrest-typegen` directly only so `tsconfig.types.json` can
   * pin its types to `dist/*.d.ts`; the copy that runs is the one `@supabase/typegen` pins. Both
   * must name the same version, or type-checking describes a different generator than the one
   * that produces the output.
   */
  it("pins @supabase/postgrest-typegen to the version @supabase/typegen pins", () => {
    const typegenDir = dirname(dirname(fileURLToPath(import.meta.resolve("@supabase/typegen"))));
    const registryPin = readPackageJson(typegenDir).dependencies?.["@supabase/postgrest-typegen"];
    const cliPin = readPackageJson(join(import.meta.dirname, "../../../..")).devDependencies?.[
      "@supabase/postgrest-typegen"
    ];
    expect(registryPin).toBeDefined();
    expect(cliPin).toBe(registryPin);
  });
});
