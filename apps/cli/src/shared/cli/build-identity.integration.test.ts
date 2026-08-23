import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCliBuildIdentity, type SourceIdentitySnapshot } from "./version.ts";

const execFile = promisify(execFileCallback);

const snapshot = (overrides: Partial<SourceIdentitySnapshot> = {}): SourceIdentitySnapshot => ({
  repositoryRoot: "/repo",
  head: "0123456789abcdef",
  stagedDiff: "",
  unstagedDiff: "",
  untrackedFiles: [],
  ...overrides,
});

describe("CLI build identity", () => {
  it.effect("uses an immutable release identity", () =>
    Effect.gen(function* () {
      const identity = yield* resolveCliBuildIdentity({
        cliVersion: "2.61.0",
        release: true,
        source: snapshot(),
      });
      expect(identity).toEqual({ cliVersion: "2.61.0", buildId: "release:2.61.0" });
    }),
  );

  it.effect("hashes commit, diffs, and sorted relevant untracked files", () =>
    Effect.gen(function* () {
      const first = yield* resolveCliBuildIdentity({
        cliVersion: "0.0.0-dev",
        source: snapshot({
          untrackedFiles: [
            { path: "src/z.ts", content: "z" },
            { path: "src/a.ts", content: "a" },
          ],
        }),
      });
      const second = yield* resolveCliBuildIdentity({
        cliVersion: "0.0.0-dev",
        source: snapshot({
          untrackedFiles: [
            { path: "src/a.ts", content: "a" },
            { path: "src/z.ts", content: "z" },
          ],
        }),
      });
      const changed = yield* resolveCliBuildIdentity({
        cliVersion: "0.0.0-dev",
        source: snapshot({ unstagedDiff: "changed" }),
      });
      expect(first.buildId).toMatch(/^source:[0-9a-f]{64}$/);
      expect(first.buildId).toBe(second.buildId);
      expect(first.buildId).not.toBe(changed.buildId);
      expect(first.buildId).not.toContain("0.0.0-dev");
    }),
  );

  it.effect("fails closed when source identity is unavailable", () =>
    Effect.gen(function* () {
      const exit = yield* resolveCliBuildIdentity({
        cliVersion: "0.0.0-dev",
        source: null,
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it("carries a changed source identity through compiled Bun child re-entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "supabase-cli-build-identity-"));
    try {
      const probe = join(root, "probe.ts");
      await writeFile(probe, 'console.log(process.env.SUPABASE_CLI_BUILD_ID ?? "missing");\n');
      const first = await Effect.runPromise(
        resolveCliBuildIdentity({
          cliVersion: "0.0.0-dev",
          source: snapshot({ unstagedDiff: "const value = 1;" }),
        }),
      );
      const second = await Effect.runPromise(
        resolveCliBuildIdentity({
          cliVersion: "0.0.0-dev",
          source: snapshot({ unstagedDiff: "const value = 2;" }),
        }),
      );
      expect(first.buildId).not.toBe(second.buildId);

      const compileAndRun = async (buildId: string, name: string) => {
        const executable = join(root, name);
        const compile = await execFile("bun", [
          "build",
          probe,
          "--compile",
          `--define=process.env.SUPABASE_CLI_VERSION=${JSON.stringify("0.0.0-dev")}`,
          `--define=process.env.SUPABASE_CLI_BUILD_ID=${JSON.stringify(buildId)}`,
          `--outfile=${executable}`,
        ]);
        expect(compile.stderr).not.toContain("error");
        const child = await execFile(executable);
        return child.stdout.trim();
      };

      expect(await compileAndRun(first.buildId, "probe-first")).toBe(first.buildId);
      expect(await compileAndRun(second.buildId, "probe-second")).toBe(second.buildId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
