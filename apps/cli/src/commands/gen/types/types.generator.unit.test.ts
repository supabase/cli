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
});
