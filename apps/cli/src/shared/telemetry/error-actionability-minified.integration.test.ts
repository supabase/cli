import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

describe("release-minified error fingerprints", () => {
  test("keeps a declared tagged error's source identifier", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "supabase-error-actionability-"));
    const bundlePath = join(tempDir, "fixture.mjs");
    const errorModule = resolve(import.meta.dirname, "../functions/delete.errors.ts");
    const plainErrorModule = resolve(
      import.meta.dirname,
      "../../legacy/shared/legacy-config-validate.ts",
    );
    const classifierModule = resolve(import.meta.dirname, "error-actionability.ts");

    try {
      const build = await Bun.build({
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
      });

      expect(build.success, build.logs.map(String).join("\n")).toBe(true);
      expect(build.outputs).toHaveLength(1);
      const output = build.outputs[0];
      expect(output).toBeDefined();
      if (output === undefined) return;

      await Bun.write(bundlePath, output);
      const fixture = await import(`${pathToFileURL(bundlePath).href}?run=${crypto.randomUUID()}`);
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
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
