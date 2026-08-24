import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Crypto, Data, Effect, FileSystem, Path } from "effect";

class MinifiedTestError extends Data.TaggedError("MinifiedTestError")<{
  readonly cause: unknown;
}> {}

describe("release-minified error fingerprints", () => {
  test("keeps a declared tagged error's source identifier", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const tempDir = yield* fs.makeTempDirectory({ prefix: "supabase-error-actionability-" });
        const bundlePath = path.join(tempDir, "fixture.mjs");
        const errorModule = path.join(import.meta.dirname, "../functions/delete.errors.ts");
        const plainErrorModule = path.join(
          import.meta.dirname,
          "../../legacy/shared/legacy-config-validate.ts",
        );
        const classifierModule = path.join(import.meta.dirname, "error-actionability.ts");

        const build = yield* Effect.tryPromise({
          try: () =>
            Bun.build({
              entrypoints: ["actionability-fixture"],
              target: "bun",
              minify: true,
              plugins: [
                {
                  name: "actionability-fixture",
                  setup(builder) {
                    builder.onResolve({ filter: /^actionability-fixture$/ }, () => ({
                      path: "actionability-fixture",
                      namespace: "actionability-fixture",
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "actionability-fixture" }, () => ({
                      contents: `
                          import { InvalidFunctionSlugError } from ${JSON.stringify(errorModule)};
                          import { LegacyConfigValidateError } from ${JSON.stringify(plainErrorModule)};
                          import { classifyCliErrorActionability } from ${JSON.stringify(classifierModule)};
                          export const taggedConstructorName = InvalidFunctionSlugError.name;
                          export const taggedClassification = classifyCliErrorActionability(
                            new InvalidFunctionSlugError({ message: "private user input" }),
                          );
                          export const plainConstructorName = LegacyConfigValidateError.name;
                          export const plainClassification = classifyCliErrorActionability(
                            new LegacyConfigValidateError("private user input"),
                          );
                        `,
                      loader: "ts",
                    }));
                  },
                },
              ],
            }),
          catch: (cause) => new MinifiedTestError({ cause }),
        });

        expect(build.success, build.logs.map(String).join("\n")).toBe(true);
        expect(build.outputs).toHaveLength(1);
        const output = build.outputs[0];
        expect(output).toBeDefined();
        if (output === undefined) return;

        const bundleBytes = yield* Effect.tryPromise({
          try: () => output.arrayBuffer(),
          catch: (cause) => new MinifiedTestError({ cause }),
        });
        yield* fs.writeFile(bundlePath, new Uint8Array(bundleBytes));
        const runId = yield* crypto.randomUUIDv4;
        const fixture = yield* Effect.tryPromise({
          try: () => import(`${pathToFileURL(bundlePath).href}?run=${runId}`),
          catch: (cause) => new MinifiedTestError({ cause }),
        });
        expect(Reflect.get(fixture, "taggedConstructorName")).not.toBe("InvalidFunctionSlugError");
        expect(Reflect.get(fixture, "taggedClassification")).toEqual({
          error_kind: "user_actionable",
          error_category: "invalid_input",
          error_fingerprint: "tag:InvalidFunctionSlugError",
          has_suggestion: true,
          suggestion_type: "provide_flags",
        });
        expect(Reflect.get(fixture, "plainConstructorName")).not.toBe("LegacyConfigValidateError");
        expect(Reflect.get(fixture, "plainClassification")).toEqual({
          error_kind: "user_actionable",
          error_category: "invalid_config",
          error_fingerprint: "error:LegacyConfigValidateError",
          has_suggestion: true,
          suggestion_type: "update_config",
        });
        yield* fs.remove(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer)),
    ));
});
