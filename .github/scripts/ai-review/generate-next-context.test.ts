import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";

import { afterEach, describe, expect, test } from "bun:test";

import { generateNextContext } from "./generate-next-context.ts";

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: git ${args.join(" ")}`);
  }
  return result.stdout.toString().trim();
}

const commitFile = Effect.fnUntraced(function* (seed: string, file: string, message: string) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  yield* fs.writeFileString(join(seed, file), `${message}\n`);
  git(seed, "add", file);
  git(seed, "commit", "-m", message);
});

const setupRepository = Effect.fnUntraced(function* (options: {
  withNext: boolean;
  nextSubjects?: string[];
}) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "ai-review-next-" });
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");

  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "develop", seed);
  git(seed, "config", "user.name", "AI Review Test");
  git(seed, "config", "user.email", "ai-review@example.test");
  yield* commitFile(seed, "shared.txt", "chore: common base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "develop");
  if (options.withNext) {
    git(seed, "switch", "-c", "next");
    if (options.nextSubjects) {
      yield* Effect.forEach(options.nextSubjects, (subject, index) =>
        commitFile(seed, `file-${index}.txt`, subject),
      );
    } else {
      yield* commitFile(seed, "go.txt", "chore: tidy");
      yield* commitFile(seed, "sidecar.txt", "feat(cli)!: remove the Go sidecar");
    }
    git(seed, "push", "origin", "next");
  }
  git(root, "clone", "--branch", "develop", remote, checkout);
  git(checkout, "update-ref", "refs/ai-review/base", "refs/remotes/origin/develop");
  return { checkout, output: join(root, "out", "next-context.md") };
});

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const directory of temporaryDirectories.splice(0)) {
        yield* fs.remove(directory, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunFileSystem.layer)),
  ),
);

describe("generateNextContext", () => {
  test("writes breaking titles first and the changed files when next exists", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { checkout, output } = yield* setupRepository({ withNext: true });

        expect(
          generateNextContext({ repositoryPath: checkout, baseRef: "develop", outputPath: output }),
        ).toBe(true);

        const context = yield* fs.readFileString(output);
        expect(context.indexOf("- feat(cli)!: remove the Go sidecar")).toBeGreaterThan(-1);
        expect(context.indexOf("- feat(cli)!: remove the Go sidecar")).toBeLessThan(
          context.indexOf("- chore: tidy"),
        );
        expect(context).toContain("sidecar.txt");
        expect(context).not.toContain("common base");
      }).pipe(Effect.provide(layer)),
    ));

  test("fences the commit list so a subject cannot break out of it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { checkout, output } = yield* setupRepository({
          withNext: true,
          nextSubjects: ["chore: ```evil``` end ``` more"],
        });

        expect(
          generateNextContext({ repositoryPath: checkout, baseRef: "develop", outputPath: output }),
        ).toBe(true);

        const lines = (yield* fs.readFileString(output)).split("\n");
        expect(lines.filter((line) => line.includes("`") && line.startsWith("```"))).toHaveLength(
          4,
        );
        expect(lines.filter((line) => line.startsWith("- ") && line.includes("`"))).toEqual([]);
        expect(lines).toContain("- chore: '''evil''' end ''' more");
      }).pipe(Effect.provide(layer)),
    ));

  test("caps each commit subject length", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { checkout, output } = yield* setupRepository({
          withNext: true,
          nextSubjects: [`chore: ${"x".repeat(500)}`],
        });

        generateNextContext({ repositoryPath: checkout, baseRef: "develop", outputPath: output });

        const subject = (yield* fs.readFileString(output))
          .split("\n")
          .find((line) => line.startsWith("- chore:"));
        expect(subject).toHaveLength(120 + 1);
        expect(subject?.endsWith("…")).toBe(true);
      }).pipe(Effect.provide(layer)),
    ));

  test("writes nothing when next has no commits ahead of develop", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { checkout, output } = yield* setupRepository({ withNext: true, nextSubjects: [] });

        expect(
          generateNextContext({ repositoryPath: checkout, baseRef: "develop", outputPath: output }),
        ).toBe(false);
        expect(yield* fs.exists(output)).toBe(false);
      }).pipe(Effect.provide(layer)),
    ));

  test("writes nothing when next does not exist", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { checkout, output } = yield* setupRepository({ withNext: false });

        expect(
          generateNextContext({ repositoryPath: checkout, baseRef: "develop", outputPath: output }),
        ).toBe(false);
        expect(yield* fs.exists(output)).toBe(false);
      }).pipe(Effect.provide(layer)),
    ));

  test("writes nothing for pull requests that do not target develop", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { checkout, output } = yield* setupRepository({ withNext: true });

        expect(
          generateNextContext({ repositoryPath: checkout, baseRef: "main", outputPath: output }),
        ).toBe(false);
        expect(yield* fs.exists(output)).toBe(false);
      }).pipe(Effect.provide(layer)),
    ));
});
