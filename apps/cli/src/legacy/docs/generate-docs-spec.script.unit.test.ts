import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const cliRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * Subprocess-level coverage of the `scripts/generate-docs-spec.ts` entrypoint
 * — the contract `docs/README.md` documents: the spec YAML is the ONLY thing
 * on stdout (`> cli_v1_commands.yaml` must yield a clean parseable file), the
 * version defaults to `latest`, and a `v`-prefixed argument is stripped. The
 * builder itself is covered in-process by `legacy-docs-spec.unit.test.ts`;
 * these two spawns pin the argv handling, path resolution, and stdout purity
 * that direct helper calls cannot.
 */
describe("generate-docs-spec.ts entrypoint", () => {
  function runScript(args: ReadonlyArray<string>): { stdout: string; stderr: string } {
    const result = Bun.spawnSync(["bun", "scripts/generate-docs-spec.ts", ...args], {
      cwd: cliRoot,
    });
    expect(result.exitCode).toBe(0);
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  it("emits only parseable spec YAML on stdout, defaulting the version to latest", () => {
    const { stdout, stderr } = runScript([]);
    expect(stderr).toBe("");
    const spec = parse(stdout);
    expect(spec.clispec).toBe("001");
    expect(spec.info.version).toBe("latest");
    expect(spec.commands.length).toBeGreaterThanOrEqual(144);
  }, 30_000);

  it("strips a leading v from the version argument", () => {
    const { stdout } = runScript(["v2.113.0"]);
    expect(parse(stdout).info.version).toBe("2.113.0");
  }, 30_000);
});
