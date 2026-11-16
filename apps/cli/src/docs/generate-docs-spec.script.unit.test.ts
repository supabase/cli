import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { parse } from "yaml";
import { Effect } from "effect";
import { rootCommand } from "../cli/root.ts";
import { validateDocsSpec } from "../../scripts/docs-spec-validation.ts";

const cliRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Subprocess-level coverage of the `scripts/generate-docs-spec.ts` entrypoint (see
 * `docs/README.md` for the full contract): the spec YAML is the only thing on stdout, the
 * version defaults to `latest`, and a `v`-prefixed argument is stripped. `docs-spec.unit.test.ts`
 * covers the builder itself in-process; these spawns pin the argv handling and stdout purity
 * that direct calls can't.
 */
describe("generate-docs-spec.ts entrypoint", () => {
  function runScript(args: ReadonlyArray<string>): { stdout: string; stderr: string } {
    const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...environment } = process.env;
    const result = Bun.spawnSync(["bun", "scripts/generate-docs-spec.ts", ...args], {
      cwd: cliRoot,
      env: environment,
    });
    expect(result.exitCode).toBe(0);
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  it.effect(
    "emits a publishable spec on stdout, defaulting the version to latest",
    () =>
      Effect.gen(function* () {
        const { stdout, stderr } = yield* Effect.sync(() => runScript([]));
        expect(stderr).toBe("");
        const spec = yield* validateDocsSpec(stdout, "latest", rootCommand);
        expect(spec.clispec).toBe("001");
        expect(spec.info.version).toBe("latest");
      }),
    30_000,
  );

  it("strips a leading v from the version argument", () => {
    const { stdout } = runScript(["v2.113.0"]);
    expect(parse(stdout).info.version).toBe("2.113.0");
  }, 30_000);
});
