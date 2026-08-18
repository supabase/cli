import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

const cliRoot = path.resolve(import.meta.dirname, "..");

function runScript(
  args: ReadonlyArray<string>,
  stdin: string,
): { exitCode: number; stdout: string; stderr: string } {
  const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...environment } = process.env;
  const result = Bun.spawnSync(["bun", "scripts/publish-docs-spec.ts", ...args], {
    cwd: cliRoot,
    env: environment,
    stdin: Buffer.from(stdin),
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function validSpec(version: string): string {
  return stringify({
    clispec: "001",
    info: { id: "cli", version, title: "Supabase CLI" },
    commands: Array.from({ length: 144 }, (_, index) => ({ id: `supabase-command-${index}` })),
  });
}

describe("publish-docs-spec.ts entrypoint", () => {
  it("prints usage and fails without --version", () => {
    const { exitCode, stderr } = runScript(["--dry-run"], validSpec("1.0.0"));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  }, 30_000);

  it("refuses an empty spec", () => {
    const { exitCode, stderr } = runScript(["--version", "1.0.0", "--dry-run"], "");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Refusing to publish an empty spec");
  }, 30_000);

  it("refuses a spec that is not valid clispec YAML", () => {
    const { exitCode, stderr } = runScript(
      ["--version", "1.0.0", "--dry-run"],
      "clispec: [unclosed",
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Refusing to publish");
  }, 30_000);

  it("refuses a truncated spec with too few commands", () => {
    const truncated = stringify({
      clispec: "001",
      info: { id: "cli", version: "1.0.0", title: "Supabase CLI" },
      commands: [{ id: "supabase-init" }],
    });
    const { exitCode, stderr } = runScript(["--version", "1.0.0", "--dry-run"], truncated);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected at least 144");
  }, 30_000);

  it("refuses a spec whose version does not match --version", () => {
    const { exitCode, stderr } = runScript(["--version", "1.0.0", "--dry-run"], validSpec("2.0.0"));
    expect(exitCode).toBe(1);
    expect(stderr).toContain("does not match --version 1.0.0");
  }, 30_000);

  it("summarizes a valid spec in dry-run mode without publishing", () => {
    const spec = validSpec("1.0.0");
    const { exitCode, stdout, stderr } = runScript(["--version", "1.0.0", "--dry-run"], spec);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(
      `Would publish ${spec.length} bytes to supabase/supabase:apps/docs/spec/cli_v1_commands.yaml on branch cli/ref-doc`,
    );
  }, 30_000);
});
