import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const encodeSpecifier = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

describe("release-minified error fingerprints", () => {
  it.live("keeps a declared tagged error's source identifier", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-error-actionability-",
      });
      const bundlePath = path.join(tempDir, "fixture.mjs");
      const errorModule = yield* encodeSpecifier(
        path.resolve(import.meta.dirname, "../functions/delete.errors.ts"),
      );
      const plainErrorModule = yield* encodeSpecifier(
        path.resolve(import.meta.dirname, "../../command-internal/config-validate.ts"),
      );
      const classifierModule = yield* encodeSpecifier(
        path.resolve(import.meta.dirname, "error-actionability.ts"),
      );

      const build = yield* Effect.tryPromise(() =>
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
                    import { InvalidFunctionSlugError } from ${errorModule};
                    import { ConfigValidateError } from ${plainErrorModule};
                    import { classifyCliErrorActionability } from ${classifierModule};
                    export const taggedConstructorName = InvalidFunctionSlugError.name;
                    export const taggedClassification = classifyCliErrorActionability(
                      new InvalidFunctionSlugError({ message: "private user input" }),
                    );
                    export const plainConstructorName = ConfigValidateError.name;
                    export const plainClassification = classifyCliErrorActionability(
                      new ConfigValidateError("private user input"),
                    );
                  `,
                  loader: "ts",
                }));
              },
            },
          ],
        }),
      );

      expect(build.success, build.logs.map(String).join("\n")).toBe(true);
      expect(build.outputs).toHaveLength(1);
      const output = build.outputs[0];
      expect(output).toBeDefined();
      if (output === undefined) return;

      yield* Effect.tryPromise(() => Bun.write(bundlePath, output));
      const fixture = yield* Effect.tryPromise(
        () => import(`${pathToFileURL(bundlePath).href}?run=${randomUUID()}`),
      );
      expect(Reflect.get(fixture, "taggedConstructorName")).not.toBe("InvalidFunctionSlugError");
      expect(Reflect.get(fixture, "taggedClassification")).toEqual({
        error_kind: "user_actionable",
        error_category: "invalid_input",
        error_fingerprint: "tag:InvalidFunctionSlugError",
        has_suggestion: true,
        suggestion_type: "provide_flags",
      });
      expect(Reflect.get(fixture, "plainConstructorName")).not.toBe("ConfigValidateError");
      expect(Reflect.get(fixture, "plainClassification")).toEqual({
        error_kind: "user_actionable",
        error_category: "invalid_config",
        error_fingerprint: "error:ConfigValidateError",
        has_suggestion: true,
        suggestion_type: "update_config",
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
