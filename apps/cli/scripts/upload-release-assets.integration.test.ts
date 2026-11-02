import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { fileURLToPath } from "node:url";
import {
  createSpawnRun,
  KILL_GRACE_MS,
  releaseAssets,
  uploadAssets,
  uploadedAssetNames,
  type ReleaseIo,
} from "./upload-release-assets.ts";

const scriptPath = fileURLToPath(new URL("./upload-release-assets.ts", import.meta.url));
const asset = {
  path: "dist/supabase_1.0.0_darwin_arm64.tar.gz",
  name: "supabase_1.0.0_darwin_arm64.tar.gz",
};
const platformLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(process.env, { preserveEmptyStrings: true })),
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

// A stand-in `gh` that logs every call, fails or hangs once per marker file, and serves
// `release view` from view.json.
const fakeGh = `#!/usr/bin/env bash
dir="$FAKE_GH_DIR"
echo "$*" >> "$dir/calls.log"
if [ "$1 $2" = "release view" ]; then
  cat "$dir/view.json"
  exit 0
fi
name="$(basename "$4")"
if [ -f "$dir/fail-once-$name" ]; then
  rm "$dir/fail-once-$name"
  echo "HTTP 500: Error saving asset" >&2
  exit 1
fi
if [ -f "$dir/hang-once-$name" ]; then
  rm "$dir/hang-once-$name"
  exec sleep 30
fi
if [ -f "$dir/ignore-term-once-$name" ]; then
  rm "$dir/ignore-term-once-$name"
  trap '' TERM
  sleep 30 & wait $!
fi
exit 0
`;

const fakeGhOnPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "upload-release-assets-" });
  const bin = path.join(directory, "bin");
  yield* fs.makeDirectory(bin);
  yield* fs.writeFileString(path.join(bin, "gh"), fakeGh);
  yield* fs.chmod(path.join(bin, "gh"), 0o755);
  const inheritedPath = Option.getOrUndefined(yield* Config.option(Config.String("PATH")));
  const env = { ...process.env, FAKE_GH_DIR: directory, PATH: `${bin}:${inheritedPath}` };
  const calls = fs
    .readFileString(path.join(directory, "calls.log"))
    .pipe(Effect.map((text) => text.trimEnd().split("\n")));
  return { directory, env, calls };
});

function recordingIo(run: ReleaseIo["run"]): { io: ReleaseIo; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    io: {
      run,
      fileExists: () => Effect.succeed(true),
      sleep: () => Effect.void,
      log: (line) =>
        Effect.sync(() => {
          logs.push(line);
        }),
    },
  };
}

describe("upload-release-assets against a fake gh", () => {
  it.live(
    "kills an upload that outlives the timeout and succeeds on the retry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { directory, env, calls } = yield* fakeGhOnPath;
        yield* fs.writeFileString(path.join(directory, `hang-once-${asset.name}`), "");
        const { io, logs } = recordingIo(createSpawnRun(env));
        const startedAt = yield* Clock.currentTimeMillis;

        yield* uploadAssets("v1.0.0", [asset], io, {
          maxAttempts: 2,
          timeoutMs: 5_000,
          backoffMs: () => 0,
        });

        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        expect(elapsed).toBeGreaterThanOrEqual(5_000);
        expect(elapsed).toBeLessThan(25_000);
        expect(yield* calls).toEqual([
          `release upload v1.0.0 ${asset.path} --clobber`,
          `release upload v1.0.0 ${asset.path} --clobber`,
        ]);
        expect(logs).toEqual([
          `Upload of ${asset.name} failed on attempt 1 (timed out after 5s); retrying in 0s.`,
          `Uploaded ${asset.name} (attempt 2).`,
        ]);
      }).pipe(Effect.provide(platformLayer)),
    40_000,
  );

  it.live(
    "kills an upload that ignores SIGTERM once the grace period passes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { directory, env, calls } = yield* fakeGhOnPath;
        yield* fs.writeFileString(path.join(directory, `ignore-term-once-${asset.name}`), "");
        const { io, logs } = recordingIo(createSpawnRun(env));
        const startedAt = yield* Clock.currentTimeMillis;

        yield* uploadAssets("v1.0.0", [asset], io, {
          maxAttempts: 2,
          timeoutMs: 5_000,
          backoffMs: () => 0,
        });

        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        expect(elapsed).toBeGreaterThanOrEqual(5_000 + KILL_GRACE_MS);
        expect(elapsed).toBeLessThan(25_000);
        expect(yield* calls).toHaveLength(2);
        expect(logs[0]).toBe(
          `Upload of ${asset.name} failed on attempt 1 (timed out after 5s); retrying in 0s.`,
        );
      }).pipe(Effect.provide(platformLayer)),
    40_000,
  );

  it.live("surfaces gh's stderr for a failed attempt and retries it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, env, calls } = yield* fakeGhOnPath;
      yield* fs.writeFileString(path.join(directory, `fail-once-${asset.name}`), "");
      const { io, logs } = recordingIo(createSpawnRun(env));

      yield* uploadAssets("v1.0.0", [asset], io, {
        maxAttempts: 2,
        timeoutMs: 5_000,
        backoffMs: () => 0,
      });

      expect(yield* calls).toHaveLength(2);
      expect(logs[0]).toBe(
        `Upload of ${asset.name} failed on attempt 1 (exit 1: HTTP 500: Error saving asset); retrying in 0s.`,
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("reads uploaded asset names from gh release view", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, env } = yield* fakeGhOnPath;
      yield* fs.writeFileString(
        path.join(directory, "view.json"),
        yield* encodeJson({
          assets: [
            { name: "install", state: "uploaded" },
            { name: "checksums.txt", state: "starter" },
          ],
        }),
      );
      const { io } = recordingIo(createSpawnRun(env));

      expect(yield* uploadedAssetNames("v1.0.0", io)).toEqual(["install"]);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live(
    "runs as a command and uploads all 22 assets from the working directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { directory, env, calls } = yield* fakeGhOnPath;
        const workdir = path.join(directory, "work");
        yield* fs.makeDirectory(path.join(workdir, "dist"), { recursive: true });
        for (const asset of releaseAssets("1.0.0")) {
          yield* fs.writeFileString(path.join(workdir, asset.path), asset.name);
        }
        const bunExecutable = Bun.which("bun");
        if (!bunExecutable) throw new Error("Bun executable not found");

        const child = Bun.spawn([bunExecutable, scriptPath, "upload", "--version", "1.0.0"], {
          cwd: workdir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            Effect.promise(() => child.exited),
            Effect.promise(() => new Response(child.stdout).text()),
            Effect.promise(() => new Response(child.stderr).text()),
          ],
          { concurrency: "unbounded" },
        );

        expect(exitCode, stderr).toBe(0);
        expect(yield* calls).toHaveLength(22);
        expect(stdout.trim().split("\n")).toHaveLength(22);
        expect(stdout).toContain("Uploaded install (attempt 1).");
      }).pipe(Effect.provide(platformLayer)),
    20_000,
  );
});
