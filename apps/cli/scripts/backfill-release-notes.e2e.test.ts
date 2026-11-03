import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./backfill-release-notes.ts", import.meta.url));
const cliPackagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const analyzerPath = fileURLToPath(new URL("./analyze-commits-title.js", import.meta.url));
const platformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const decodeCliPackage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ release: Schema.Unknown })),
);
const encodePackage = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const isolatedGit = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "seed",
  GIT_AUTHOR_EMAIL: "seed@example.com",
  GIT_COMMITTER_NAME: "seed",
  GIT_COMMITTER_EMAIL: "seed@example.com",
};

const spawn = (argv: ReadonlyArray<string>, cwd: string, env: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        Effect.promise(() => child.exited),
        Effect.promise(() => new Response(child.stdout).text()),
        Effect.promise(() => new Response(child.stderr).text()),
      ],
      { concurrency: "unbounded" },
    );
    return { exitCode, stdout, stderr };
  });

interface SeedHistory {
  readonly git: (...args: ReadonlyArray<string>) => Effect.Effect<string>;
  readonly commit: (message: string) => Effect.Effect<string>;
  readonly release: (tag: string, channels: string) => Effect.Effect<void>;
}

/**
 * A working repository on `main` with an `origin` bare remote, `v1.0.0` on its first commit and
 * the history `seed` adds on top. Every branch and tag is pushed, and every release also gets
 * the per-tag channel note ref the release pipeline pushes.
 */
const repositoryWithHistory = (seed: (history: SeedHistory) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "backfill-release-notes-" });
    const origin = path.join(root, "origin.git");
    const work = path.join(root, "work");
    const env = { ...process.env, ...isolatedGit };

    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const result = yield* spawn(["git", ...args], cwd, env);
        expect(result.exitCode, result.stderr).toBe(0);
        return result.stdout;
      });
    const commit = (message: string) =>
      git(work, "commit", "--quiet", "--allow-empty", "-m", message);
    const release = (tag: string, channels: string) =>
      Effect.gen(function* () {
        yield* git(work, "tag", "-a", tag, "-m", `Release ${tag}`);
        yield* git(
          work,
          "notes",
          `--ref=semantic-release-${tag}`,
          "add",
          "-m",
          `{"channels":${channels}}`,
          `${tag}^{commit}`,
        );
      });

    const cliPackage = yield* decodeCliPackage(yield* fs.readFileString(cliPackagePath));
    const packageJson = yield* encodePackage({
      name: "supabase",
      version: "0.0.0-automated",
      repository: { type: "git", url: "https://github.com/supabase/cli" },
      release: cliPackage.release,
    });
    yield* fs.makeDirectory(path.join(work, "apps/cli/scripts"), { recursive: true });
    yield* fs.writeFileString(path.join(work, "apps/cli/package.json"), `${packageJson}\n`);
    yield* fs.copyFile(analyzerPath, path.join(work, "apps/cli/scripts/analyze-commits-title.js"));

    yield* git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    yield* git(work, "init", "--quiet", "--initial-branch=main");
    yield* git(work, "remote", "add", "origin", origin);
    yield* git(work, "add", "-A");
    yield* commit("feat: initial");
    yield* release("v1.0.0", "[null]");

    yield* seed({ git: (...args) => git(work, ...args), commit, release });

    yield* git(
      work,
      "push",
      "--quiet",
      "origin",
      "refs/heads/*:refs/heads/*",
      "refs/tags/*:refs/tags/*",
      "refs/notes/*:refs/notes/*",
    );

    const bunExecutable = Bun.which("bun");
    if (!bunExecutable) throw new Error("Bun executable not found");
    const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...inherited } = process.env;

    return {
      backfill: (tag: string) =>
        spawn([bunExecutable, scriptPath, "--tag", tag], work, { ...inherited, ...isolatedGit }),
    };
  });

/**
 * `develop` and `next` share the commit that carries both `v1.1.0-beta.1` and `v1.1.0-next.1`
 * (`next` is fast-forwarded onto `develop`), and `develop` moves on to `v1.1.0-beta.2`.
 */
const sharedBetaAndNextHistory = repositoryWithHistory(({ git, commit, release }) =>
  Effect.gen(function* () {
    yield* git("switch", "--quiet", "--create", "develop");
    yield* commit("feat: add shared thing");
    yield* release("v1.1.0-beta.1", '["beta"]');
    yield* release("v1.1.0-next.1", '["next"]');
    yield* git("branch", "next");
    yield* commit("fix: patch beta");
    yield* release("v1.1.0-beta.2", '["beta"]');
  }),
);

const forcedMaintenanceHistory = repositoryWithHistory(({ git, commit, release }) =>
  Effect.gen(function* () {
    yield* commit("feat!: drop the legacy flag");
    yield* release("v2.0.0", "[null]");
    yield* git("switch", "--quiet", "--create", "v1.x", "v1.0.0");
    yield* commit("ci: pin the runner image");
    yield* release("v1.0.1", '["v1.stable"]');
  }),
);

describe("backfill-release-notes.ts on a repository whose beta and next tags share a commit", () => {
  it.live("backfills the next beta from the beta line instead of the next channel's tags", () =>
    Effect.gen(function* () {
      const repository = yield* sharedBetaAndNextHistory;

      const { exitCode, stdout, stderr } = yield* repository.backfill("v1.1.0-beta.2");

      expect(exitCode, stderr).toBe(0);
      expect(stdout, stderr).toContain("compare/v1.1.0-beta.1...v1.1.0-beta.2");
      expect(stdout, stderr).toContain("patch beta");
      expect(stdout, stderr).not.toContain("add shared thing");
    }).pipe(Effect.provide(platformLayer)),
  );
});

describe("backfill-release-notes.ts on a maintenance line", () => {
  it.live("backfills a forced maintenance release whose commits imply no release", () =>
    Effect.gen(function* () {
      const repository = yield* forcedMaintenanceHistory;

      const { exitCode, stdout, stderr } = yield* repository.backfill("v1.0.1");

      expect(exitCode, stderr).toBe(0);
      expect(stdout, stderr).toContain("compare/v1.0.0...v1.0.1");
    }).pipe(Effect.provide(platformLayer)),
  );
});
