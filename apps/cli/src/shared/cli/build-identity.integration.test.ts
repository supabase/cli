import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  captureCliSourceIdentityAt,
  resolveCliBuildIdentity,
  type SourceIdentitySnapshot,
} from "./version.ts";

const sourceBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

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
            { path: "src/z.ts", content: sourceBytes("z") },
            { path: "src/a.ts", content: sourceBytes("a") },
          ],
        }),
      });
      const second = yield* resolveCliBuildIdentity({
        cliVersion: "0.0.0-dev",
        source: snapshot({
          untrackedFiles: [
            { path: "src/a.ts", content: sourceBytes("a") },
            { path: "src/z.ts", content: sourceBytes("z") },
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

  it("includes every non-ignored untracked regular file in a real git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "supabase-cli-source-identity-"));
    try {
      await execFile("git", ["init", root]);
      await execFile("git", ["-C", root, "config", "user.email", "test@example.com"]);
      await execFile("git", ["-C", root, "config", "user.name", "Test"]);
      await writeFile(join(root, "tracked.ts"), "export const tracked = true;\n");
      await execFile("git", ["-C", root, "add", "tracked.ts"]);
      await execFile("git", ["-C", root, "commit", "-m", "initial"]);

      const baseline = await Effect.runPromise(
        resolveCliBuildIdentity({
          cliVersion: "0.0.0-dev",
          source: captureCliSourceIdentityAt(root),
        }),
      );
      const files: ReadonlyArray<readonly [string, Uint8Array]> = [
        ["script.sh", new TextEncoder().encode("#!/bin/sh\nprintf source\n")],
        ["script.py", new TextEncoder().encode("print('source')\n")],
        ["module.mts", new TextEncoder().encode("export const source = true;\n")],
        ["schema.proto", new TextEncoder().encode('syntax = \\"proto3\\";\n')],
        ["Dockerfile", new TextEncoder().encode("FROM scratch\n")],
        ["binary-source", new Uint8Array([0, 255, 1, 254])],
      ];

      for (const [path, content] of files) {
        await writeFile(join(root, path), content);
        const changed = await Effect.runPromise(
          resolveCliBuildIdentity({
            cliVersion: "0.0.0-dev",
            source: captureCliSourceIdentityAt(root),
          }),
        );
        expect(changed.buildId, path).not.toBe(baseline.buildId);
        await rm(join(root, path));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures a staged diff larger than the child-process output buffer", async () => {
    const root = await mkdtemp(join(tmpdir(), "supabase-cli-source-identity-diff-"));
    try {
      await execFile("git", ["init", root]);
      await execFile("git", ["-C", root, "config", "user.email", "test@example.com"]);
      await execFile("git", ["-C", root, "config", "user.name", "Test"]);
      const trackedPath = join(root, "tracked.ts");
      await writeFile(trackedPath, "export const tracked = true;\n");
      await execFile("git", ["-C", root, "add", "tracked.ts"]);
      await execFile("git", ["-C", root, "commit", "-m", "initial"]);

      await writeFile(
        trackedPath,
        `export const payload = ${JSON.stringify("x".repeat(2_000_000))};\n`,
      );
      await execFile("git", ["-C", root, "add", "tracked.ts"]);

      const captured = captureCliSourceIdentityAt(root);
      expect(captured.stagedDiff.length).toBeGreaterThan(1_048_576);
      const identity = await Effect.runPromise(
        resolveCliBuildIdentity({
          cliVersion: "0.0.0-dev",
          source: captured,
        }),
      );
      expect(identity.buildId).toMatch(/^source:[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses path, size, and mtime metadata for large untracked files", async () => {
    const root = await mkdtemp(join(tmpdir(), "supabase-cli-source-identity-large-"));
    try {
      await execFile("git", ["init", root]);
      await execFile("git", ["-C", root, "config", "user.email", "test@example.com"]);
      await execFile("git", ["-C", root, "config", "user.name", "Test"]);
      await writeFile(join(root, "tracked.ts"), "export const tracked = true;\n");
      await execFile("git", ["-C", root, "add", "tracked.ts"]);
      await execFile("git", ["-C", root, "commit", "-m", "initial"]);

      const largePath = join(root, "large-source.bin");
      const largeSize = 1_048_577;
      const initialMtime = new Date("2020-01-02T03:04:05.000Z");
      await writeFile(largePath, new Uint8Array(largeSize).fill(65));
      await utimes(largePath, initialMtime, initialMtime);

      const captured = captureCliSourceIdentityAt(root);
      const largeFile = captured.untrackedFiles.find(({ path }) => path === "large-source.bin");
      expect(largeFile).toMatchObject({
        path: "large-source.bin",
        size: largeSize,
        mtimeMs: initialMtime.getTime(),
      });
      expect(largeFile).not.toHaveProperty("content");

      const baseline = await Effect.runPromise(
        resolveCliBuildIdentity({
          cliVersion: "0.0.0-dev",
          source: captured,
        }),
      );

      const changedMtime = new Date(initialMtime.getTime() + 1_000);
      await utimes(largePath, changedMtime, changedMtime);
      const changedMetadata = await Effect.runPromise(
        resolveCliBuildIdentity({
          cliVersion: "0.0.0-dev",
          source: captureCliSourceIdentityAt(root),
        }),
      );
      expect(changedMetadata.buildId).not.toBe(baseline.buildId);

      const smallPath = join(root, "small-source.ts");
      const smallMtime = new Date("2020-01-02T03:05:05.000Z");
      await writeFile(smallPath, "a".repeat(128));
      await utimes(smallPath, smallMtime, smallMtime);
      const smallBaseline = await Effect.runPromise(
        resolveCliBuildIdentity({
          cliVersion: "0.0.0-dev",
          source: captureCliSourceIdentityAt(root),
        }),
      );
      await writeFile(smallPath, "b".repeat(128));
      await utimes(smallPath, smallMtime, smallMtime);
      const smallChanged = await Effect.runPromise(
        resolveCliBuildIdentity({
          cliVersion: "0.0.0-dev",
          source: captureCliSourceIdentityAt(root),
        }),
      );
      expect(smallChanged.buildId).not.toBe(smallBaseline.buildId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
