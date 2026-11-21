import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";

const galleryEntry = fileURLToPath(new URL("../../../examples/gallery.ts", import.meta.url));

/** Runs a command with stdin closed and returns its exit code and decoded output. */
const execute = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly env: Record<string, string>; readonly cwd: string },
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        ...(options === undefined ? {} : { ...options, extendEnv: false }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        Stream.mkString(Stream.decodeText(child.stdout)),
        Stream.mkString(Stream.decodeText(child.stderr)),
      ],
      { concurrency: "unbounded" },
    );
    return { exitCode, stdout, stderr };
  }).pipe(Effect.scoped);

describe("compiled gallery", () => {
  it.live(
    "loads the layout engine from a compiled binary and prints a laid-out KeyValue block",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-tui-gallery-" });
        const executable = path.join(directory, "gallery");

        const build = yield* execute("bun", [
          "build",
          galleryEntry,
          "--compile",
          `--outfile=${executable}`,
        ]);
        expect(build.exitCode, build.stderr).toBe(0);

        const gallery = yield* execute(executable, [], {
          cwd: directory,
          env: { HOME: directory, LANG: "C.UTF-8" },
        });

        expect(gallery.exitCode, gallery.stderr).toBe(0);
        const lines = gallery.stdout.split("\n");
        expect(lines).toContain("KeyValue");
        expect(lines).toContainEqual(expect.stringMatching(/^│ Project my-app +│$/));
        expect(lines).toContainEqual(expect.stringMatching(/^│ Region {2}eu-west-1 +│$/));
      }).pipe(Effect.provide(NodeServices.layer)),
    90_000,
  );
});
