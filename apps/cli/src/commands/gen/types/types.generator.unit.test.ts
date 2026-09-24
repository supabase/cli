import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  generateGo,
  generatePython,
  generateSwift,
  generateTypescript,
  introspect,
  sortGeneratorMetadata,
  type GeneratorMetadata,
} from "@supabase/postgrest-typegen";

const emptyMetadata: GeneratorMetadata = {
  version: 1,
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

/**
 * `tsconfig.types.json` type-checks this package against its published `dist/*.d.ts`, while Bun
 * resolves its `bun` exports condition to `src/*.ts` at runtime. These assertions run against the
 * Bun-resolved module, so a drift between the two views fails here rather than at generation time.
 */
describe("postgrest-typegen runtime contract", () => {
  it("exposes the introspection and generation entry points the generator layer calls", () => {
    expect(typeof introspect).toBe("function");
    expect(typeof sortGeneratorMetadata).toBe("function");
    expect(typeof generateTypescript).toBe("function");
    expect(typeof generateGo).toBe("function");
    expect(typeof generatePython).toBe("function");
    expect(typeof generateSwift).toBe("function");
  });

  it.effect("renders every supported language from metadata alone", () =>
    Effect.gen(function* () {
      const metadata = sortGeneratorMetadata(emptyMetadata);

      expect(
        yield* Effect.promise(() =>
          generateTypescript(metadata, { format: (code) => Promise.resolve(code) }),
        ),
      ).toContain("public");
      expect(generateGo(metadata)).toContain("package");
      expect(generatePython(metadata)).toContain("import");
      expect(generateSwift(metadata, { accessControl: "internal" })).toContain("import Supabase");
    }),
  );
});
