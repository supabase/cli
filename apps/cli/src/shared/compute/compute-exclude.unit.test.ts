import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { compileComputeExclude, NO_COMPUTE_EXCLUSIONS } from "./compute-exclude.ts";
import { InvalidComputeExcludeError } from "./compute.errors.ts";

const compile = (patterns: ReadonlyArray<string>) =>
  Effect.runSync(compileComputeExclude({ name: "api", patterns }));

/** The refusal a pattern list earns, so each case can assert on the sentence the user reads. */
const refusal = (patterns: ReadonlyArray<string>) =>
  Effect.runSync(compileComputeExclude({ name: "api", patterns }).pipe(Effect.flip)).detail;

describe("compileComputeExclude", () => {
  it.effect("excludes nothing when the compute records no patterns", () =>
    Effect.gen(function* () {
      const absent = yield* compileComputeExclude({ name: "api", patterns: undefined });
      const empty = yield* compileComputeExclude({ name: "api", patterns: [] });

      expect(absent).toBe(NO_COMPUTE_EXCLUSIONS);
      expect(empty).toBe(NO_COMPUTE_EXCLUSIONS);
      expect(absent.active).toBe(false);
      expect(absent.excludes("node_modules", true)).toBe(false);
    }),
  );

  it.effect("reports itself active once a pattern is recorded", () =>
    Effect.gen(function* () {
      const matcher = yield* compileComputeExclude({ name: "api", patterns: [".env"] });

      expect(matcher.active).toBe(true);
    }),
  );

  describe("a pattern with no separator matches that name at any depth", () => {
    const matcher = compile(["node_modules"]);

    it.effect("matches at the top level", () =>
      Effect.sync(() => {
        expect(matcher.excludes("node_modules", true)).toBe(true);
      }),
    );

    it.effect("matches nested", () =>
      Effect.sync(() => {
        expect(matcher.excludes("packages/api/node_modules", true)).toBe(true);
      }),
    );

    it.effect("matches a file of the same name", () =>
      Effect.sync(() => {
        expect(matcher.excludes("node_modules", false)).toBe(true);
      }),
    );

    it.effect("leaves a name it merely prefixes alone", () =>
      Effect.sync(() => {
        expect(matcher.excludes("node_modules.bak", true)).toBe(false);
      }),
    );
  });

  describe("a pattern with a separator is anchored at the source directory", () => {
    const matcher = compile(["/coverage", "src/*.test.ts"]);

    it.effect("matches at the root it is anchored to", () =>
      Effect.sync(() => {
        expect(matcher.excludes("coverage", true)).toBe(true);
        expect(matcher.excludes("src/index.test.ts", false)).toBe(true);
      }),
    );

    it.effect("does not match the same name deeper in the tree", () =>
      Effect.sync(() => {
        expect(matcher.excludes("packages/api/coverage", true)).toBe(false);
        expect(matcher.excludes("app/src/index.test.ts", false)).toBe(false);
      }),
    );

    it.effect("keeps a single wildcard inside one path segment", () =>
      Effect.sync(() => {
        expect(matcher.excludes("src/nested/index.test.ts", false)).toBe(false);
      }),
    );
  });

  describe("a trailing separator matches directories only", () => {
    const matcher = compile(["dist/"]);

    it.effect("matches the directory", () =>
      Effect.sync(() => {
        expect(matcher.excludes("dist", true)).toBe(true);
        expect(matcher.excludes("packages/api/dist", true)).toBe(true);
      }),
    );

    it.effect("passes over a file of the same name", () =>
      Effect.sync(() => {
        expect(matcher.excludes("dist", false)).toBe(false);
      }),
    );
  });

  describe("`**` spans directories", () => {
    const matcher = compile(["**/*.log", "build/**/cache"]);

    it.effect("matches at every depth, including none", () =>
      Effect.sync(() => {
        expect(matcher.excludes("server.log", false)).toBe(true);
        expect(matcher.excludes("a/b/c/server.log", false)).toBe(true);
      }),
    );

    it.effect("spans zero or more segments between two fixed ones", () =>
      Effect.sync(() => {
        expect(matcher.excludes("build/cache", true)).toBe(true);
        expect(matcher.excludes("build/x/y/cache", true)).toBe(true);
      }),
    );

    it.effect("still requires the segments around it to match", () =>
      Effect.sync(() => {
        expect(matcher.excludes("build/x/cache/keep", false)).toBe(false);
        expect(matcher.excludes("other/cache", true)).toBe(false);
      }),
    );
  });

  it.effect("matches a character class within one segment", () =>
    Effect.sync(() => {
      const matcher = compile(["*.[oa]"]);

      expect(matcher.excludes("main.o", false)).toBe(true);
      expect(matcher.excludes("lib.a", false)).toBe(true);
      expect(matcher.excludes("main.c", false)).toBe(false);
    }),
  );

  it.effect("refuses a re-inclusion pattern rather than reading it as a filename", () =>
    Effect.sync(() => {
      expect(refusal(["node_modules", "!node_modules/keep"])).toContain("re-includes a path");
    }),
  );

  it.effect("refuses a pattern that names no path", () =>
    Effect.sync(() => {
      expect(refusal([""])).toContain("names no path");
      expect(refusal(["/"])).toContain("names no path");
    }),
  );

  it.effect("refuses a malformed character class", () =>
    Effect.sync(() => {
      expect(refusal(["src/[oops"])).toContain("malformed character class");
    }),
  );

  it.effect("refuses a pattern with an empty path segment", () =>
    Effect.sync(() => {
      expect(refusal(["src//dist"])).toContain("empty path segment");
    }),
  );

  it.effect("names the compute and the pattern in every refusal", () =>
    Effect.gen(function* () {
      const error = yield* compileComputeExclude({
        name: "worker",
        patterns: ["!keep"],
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(InvalidComputeExcludeError);
      expect(error.detail).toContain("[compute.worker] exclude");
      expect(error.detail).toContain('"!keep"');
      expect(error.suggestion).toContain("[compute.worker] exclude");
    }),
  );
});
