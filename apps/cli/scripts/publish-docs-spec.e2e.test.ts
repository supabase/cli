import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { parse, stringify } from "yaml";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));

function runScript(
  args: ReadonlyArray<string>,
  stdin: string,
  prependPath?: string,
): { exitCode: number; stdout: string; stderr: string } {
  const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...environment } = process.env;
  const result = Bun.spawnSync(["bun", "scripts/publish-docs-spec.ts", ...args], {
    cwd: cliRoot,
    env: {
      ...environment,
      ...(prependPath === undefined
        ? {}
        : {
            PATH: `${prependPath}${process.platform === "win32" ? ";" : ":"}${environment["PATH"] ?? ""}`,
          }),
    },
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

const localCheckout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "docs-preview-" });
  const checkout = path.join(root, "local checkout");
  const directory = path.join(checkout, "apps/docs/spec");
  yield* fs.makeDirectory(directory, { recursive: true });
  const target = path.join(directory, "cli_v1_commands.yaml");
  yield* fs.writeFileString(target, "original spec\n");
  return { root, checkout, target };
});

describe("local reference preview", () => {
  it.effect("writes formatted YAML without Git or GitHub operations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, checkout, target } = yield* localCheckout;
      const bin = path.join(root, "bin");
      yield* fs.makeDirectory(bin);
      // Fail closed if preview accidentally reaches the remote publishing workflow.
      for (const command of ["git", "gh"]) {
        const executable = path.join(bin, command);
        yield* fs.writeFileString(
          executable,
          "#!/bin/sh\necho 'Unexpected publishing operation' >&2\nexit 99\n",
        );
        yield* fs.chmod(executable, 0o755);
      }
      const spec = validSpec("1.0.0");
      const { exitCode, stdout, stderr } = yield* Effect.sync(() =>
        runScript(
          ["--version", "v1.0.0", "--local", path.relative(cliRoot, checkout)],
          spec.replace("clispec:", "clispec:   "),
          bin,
        ),
      );

      expect(exitCode, stderr).toBe(0);
      const written = yield* fs.readFileString(target);
      expect(parse(written)).toEqual(parse(spec));
      expect(written).toContain("clispec: '001'\n");
      expect(written.endsWith("\n")).toBe(true);
      expect(stdout).toContain("Wrote CLI reference to ");
      expect(yield* fs.exists(path.join(checkout, ".git"))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("leaves the local spec unchanged during a dry run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { checkout, target } = yield* localCheckout;
      const { exitCode, stdout, stderr } = yield* Effect.sync(() =>
        runScript(["--version", "1.0.0", "--local", checkout, "--dry-run"], validSpec("1.0.0")),
      );

      expect(exitCode, stderr).toBe(0);
      expect(stdout).toContain(`Would write ${validSpec("1.0.0").length} bytes to `);
      expect(yield* fs.readFileString(target)).toBe("original spec\n");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("refuses invalid input before overwriting the local spec", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { checkout, target } = yield* localCheckout;
      const { exitCode, stderr } = yield* Effect.sync(() =>
        runScript(["--version", "1.0.0", "--local", checkout], validSpec("2.0.0")),
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain("does not match --version 1.0.0");
      expect(yield* fs.readFileString(target)).toBe("original spec\n");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("refuses a spec path outside the checkout without overwriting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, checkout } = yield* localCheckout;
      const outside = path.join(root, "outside.yaml");
      yield* fs.writeFileString(outside, "keep this file\n");
      const { exitCode, stderr } = yield* Effect.sync(() =>
        runScript(
          ["--version", "1.0.0", "--local", checkout, "--spec-path", "../outside.yaml"],
          validSpec("1.0.0"),
        ),
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain("a --spec-path inside it");
      expect(yield* fs.readFileString(outside)).toBe("keep this file\n");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("refuses a missing checkout without creating it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* localCheckout;
      const missing = path.join(root, "missing");
      const { exitCode, stderr } = yield* Effect.sync(() =>
        runScript(["--version", "1.0.0", "--local", missing], validSpec("1.0.0")),
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain("Point --local at an existing supabase/supabase checkout");
      expect(yield* fs.exists(missing)).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

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
