import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, FileSystem, JsonSchema, Layer, Path } from "effect";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./publish-schemas.ts", import.meta.url));
const platformLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(process.env, { preserveEmptyStrings: true })),
);

const REPO = "supabase/supabase";
const PUBLISHED = "apps/www/public/schemas";
const SEED_IDENTITY = ["-c", "user.name=seed", "-c", "user.email=seed@example.com"];

const fakeGh = `#!/usr/bin/env bash
printf '%s' "$*" | tr '\\n' ' ' >> "$FAKE_GH_DIR/calls.log"
echo >> "$FAKE_GH_DIR/calls.log"
if [ "$1 $2" = "pr list" ]; then
  cat "$FAKE_GH_DIR/open-pulls.json"
fi
exit 0
`;

// Not prettier-formatted, so a formatting step would show up as a byte difference.
const schemaText = (name: string, version: number, marker: string) =>
  `{"$schema":"${JsonSchema.META_SCHEMA_URI_DRAFT_07}",\n\t"$id":"https://supabase.com/schemas/${name}/v${version}.json",  "marker":"${marker}"}`;

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

const writeFiles = (directory: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [file, content] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true });
      yield* fs.writeFileString(path.join(directory, file), content);
    }
  });

/**
 * A local bare repository standing in for supabase/supabase, seeded on `master`, and a schemas
 * directory to publish from. git reaches the bare repository through env-only URL rewriting and
 * `gh` is a recording fake.
 */
const harness = (options: {
  readonly target: Record<string, string>;
  readonly local: Record<string, string>;
  readonly openPulls?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "publish-schemas-" });
    const bare = path.join(root, "supabase.git");
    const seed = path.join(root, "seed");
    const schemasDir = path.join(root, "schemas");
    const bin = path.join(root, "bin");
    const tmp = path.join(root, "tmp");

    const isolatedGit = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const result = yield* spawn(["git", ...args], cwd, { ...process.env, ...isolatedGit });
        expect(result.exitCode, result.stderr).toBe(0);
        return result.stdout;
      });

    yield* fs.makeDirectory(seed);
    yield* fs.makeDirectory(tmp);
    yield* writeFiles(seed, { "README.md": "# supabase", ...options.target });
    yield* git(root, "init", "--quiet", "--bare", "--initial-branch=master", bare);
    yield* git(seed, "init", "--quiet", "--initial-branch=master");
    yield* git(seed, "add", "-A");
    yield* git(seed, ...SEED_IDENTITY, "commit", "--quiet", "-m", "seed");
    yield* git(seed, "push", "--quiet", bare, "master");

    yield* writeFiles(schemasDir, options.local);
    yield* writeFiles(bin, { gh: fakeGh });
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    yield* writeFiles(root, { "calls.log": "", "open-pulls.json": options.openPulls ?? "[]" });

    const bunExecutable = Bun.which("bun");
    if (!bunExecutable) throw new Error("Bun executable not found");
    const inheritedPath = yield* Config.String("PATH");
    const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...inherited } = process.env;
    const env = {
      ...inherited,
      ...isolatedGit,
      PATH: `${bin}:${inheritedPath}`,
      FAKE_GH_DIR: root,
      TMPDIR: tmp,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://github.com/${REPO}.git`,
    };

    return {
      publish: spawn(
        [bunExecutable, scriptPath, "--version", "1.2.3", "--schemas-dir", schemasDir],
        root,
        env,
      ),
      branches: git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").pipe(
        Effect.map((text) => text.trim().split("\n")),
      ),
      show: (ref: string, file: string) => git(bare, "show", `${ref}:${PUBLISHED}/${file}`),
      commitSubject: (ref: string) => git(bare, "log", "-1", "--format=%an: %s", ref),
      leftoverTempEntries: fs.readDirectory(tmp),
      ghCalls: fs
        .readFileString(path.join(root, "calls.log"))
        .pipe(Effect.map((text) => text.split("\n").filter((line) => line !== ""))),
    };
  });

describe("publish-schemas.ts against a local stand-in for supabase/supabase", () => {
  it.live(
    "pushes the changed schemas byte for byte, opens a PR and arms auto-merge",
    () =>
      Effect.gen(function* () {
        const config = schemaText("config", 1, "new");
        const projectConfig = schemaText("project-config", 1, "added");
        const target = yield* harness({
          target: { [`${PUBLISHED}/config/v1.json`]: schemaText("config", 1, "old") },
          local: { "config/v1.json": config, "project-config/v1.json": projectConfig },
        });

        const { exitCode, stdout, stderr } = yield* target.publish;

        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain("Pushed cli/schemas to supabase/supabase");
        expect(yield* target.branches).toEqual(["cli/schemas", "master"]);
        expect(yield* target.show("cli/schemas", "config/v1.json")).toBe(config);
        expect(yield* target.show("cli/schemas", "project-config/v1.json")).toBe(projectConfig);
        expect(yield* target.show("master", "config/v1.json")).toBe(schemaText("config", 1, "old"));
        expect(yield* target.commitSubject("cli/schemas")).toBe(
          "github-actions[bot]: chore: update cli config schemas to v1.2.3\n",
        );
        const calls = yield* target.ghCalls;
        expect(calls.map((call) => call.split(" ", 2).join(" "))).toEqual([
          "pr list",
          "pr create",
          "pr merge",
        ]);
        expect(calls[1]).toContain("--title chore: update cli config schemas --body");
        expect(calls[1]).toContain("--base master --head cli/schemas");
        expect(calls[2]).toBe("pr merge cli/schemas --repo supabase/supabase --auto --squash");
      }).pipe(Effect.provide(platformLayer)),
    60_000,
  );

  it.live(
    "arms auto-merge on the PR that is already open instead of creating another",
    () =>
      Effect.gen(function* () {
        const target = yield* harness({
          target: {},
          local: { "config/v1.json": schemaText("config", 1, "new") },
          openPulls: '[{"number":7,"headRepositoryOwner":{"login":"supabase"}}]',
        });

        const { exitCode, stdout, stderr } = yield* target.publish;

        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain("Reusing the open PR for cli/schemas");
        expect((yield* target.ghCalls).map((call) => call.split(" ", 2).join(" "))).toEqual([
          "pr list",
          "pr merge",
        ]);
      }).pipe(Effect.provide(platformLayer)),
    60_000,
  );

  it.live(
    "publishes only the current version and leaves lower versions as published",
    () =>
      Effect.gen(function* () {
        const published = schemaText("supabase-lock", 1, "published");
        const current = schemaText("supabase-lock", 2, "current");
        const target = yield* harness({
          target: { [`${PUBLISHED}/supabase-lock/v1.json`]: published },
          local: {
            "supabase-lock/v1.json": schemaText("supabase-lock", 1, "edited after the freeze"),
            "supabase-lock/v2.json": current,
          },
        });

        const { exitCode, stderr } = yield* target.publish;

        expect(exitCode, stderr).toBe(0);
        expect(yield* target.show("cli/schemas", "supabase-lock/v2.json")).toBe(current);
        expect(yield* target.show("cli/schemas", "supabase-lock/v1.json")).toBe(published);
      }).pipe(Effect.provide(platformLayer)),
    60_000,
  );

  it.live(
    "pushes nothing and opens no PR when the target already has identical files",
    () =>
      Effect.gen(function* () {
        const config = schemaText("config", 1, "same");
        const target = yield* harness({
          target: { [`${PUBLISHED}/config/v1.json`]: config },
          local: { "config/v1.json": config },
        });

        const { exitCode, stdout, stderr } = yield* target.publish;

        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain(`${PUBLISHED} is already up to date in supabase/supabase`);
        expect(yield* target.branches).toEqual(["master"]);
        expect(yield* target.ghCalls).toEqual([]);
      }).pipe(Effect.provide(platformLayer)),
    60_000,
  );

  it.live(
    "refuses to write a version below one supabase.com already serves, pushes nothing and cleans up",
    () =>
      Effect.gen(function* () {
        const target = yield* harness({
          target: { [`${PUBLISHED}/config/v2.json`]: schemaText("config", 2, "served") },
          local: { "config/v1.json": schemaText("config", 1, "local") },
        });

        const { exitCode, stdout, stderr } = yield* target.publish;

        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toBe(
          "Refusing to publish: supabase/supabase already serves config/v2.json, so writing config/v1.json would modify a frozen version.\n",
        );
        expect(yield* target.branches).toEqual(["master"]);
        expect(yield* target.ghCalls).toEqual([]);
        expect(yield* target.leftoverTempEntries).toEqual([]);
      }).pipe(Effect.provide(platformLayer)),
    60_000,
  );
});
