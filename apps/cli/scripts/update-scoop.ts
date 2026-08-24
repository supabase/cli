#!/usr/bin/env bun
import { $ } from "bun";
import { BunPath, BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Formatter, Layer } from "effect";
import * as EffectPath from "effect/Path";
import { parseArgs } from "node:util";

class ScoopUpdateError extends Data.TaggedError("ScoopUpdateError")<{
  readonly operation: string;
  readonly cause: string;
}> {}

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const fail = (operation: string, cause: unknown) =>
  new ScoopUpdateError({ operation, cause: causeMessage(cause) });

const shell = <A>(operation: string, command: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: command, catch: (cause) => fail(operation, cause) });

const output = (message: string) => Effect.sync(() => process.stdout.write(`${message}\n`));

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    repo: { type: "string", default: "supabase/cli" },
    bucket: { type: "string", default: "supabase/scoop-bucket" },
    name: { type: "string", default: "supabase" },
    local: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const version = values.version;
if (!version) {
  process.stderr.write(
    "Usage: bun run scripts/update-scoop.ts --version <version> [--repo <owner/repo>] [--bucket <owner/repo>] [--name <manifest-name>] [--local] [--dry-run]\n",
  );
  process.exit(1);
}

const repo = values.repo ?? "supabase/cli";
const bucket = values.bucket ?? "supabase/scoop-bucket";
const name = values.name ?? "supabase";
const local = values.local ?? false;
const dryRun = values["dry-run"] ?? false;

const main = Effect.gen(function* () {
  const path = yield* EffectPath.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = path.resolve(import.meta.dir, "../../..");
  const distDir = path.join(root, "dist");
  const checksumsText = yield* fs
    .readFileString(path.join(distDir, "checksums.txt"), "utf8")
    .pipe(Effect.mapError((cause) => fail("read checksums", cause)));
  const checksums = new Map<string, string>();
  for (const line of checksumsText.trim().split("\n")) {
    const [hash, file] = line.split(/\s+/);
    if (hash !== undefined && file !== undefined) checksums.set(file, hash);
  }

  const sha = (file: string) => {
    const hash = checksums.get(file);
    return hash === undefined
      ? Effect.fail(fail("read checksums", `Checksum not found for ${file}`))
      : Effect.succeed(hash);
  };
  const baseUrl = local
    ? `file:///${distDir.replace(/\\/g, "/")}`
    : `https://github.com/${repo}/releases/download/v${version}`;
  const amd64Hash = yield* sha(`supabase_${version}_windows_amd64.tar.gz`);
  const arm64Hash = yield* sha(`supabase_${version}_windows_arm64.tar.gz`);
  const amd64Tar = local
    ? `supabase_${version}_windows_amd64.tar.gz`
    : "supabase_windows_amd64.tar.gz";
  const arm64Tar = local
    ? `supabase_${version}_windows_arm64.tar.gz`
    : "supabase_windows_arm64.tar.gz";
  const manifest = {
    version,
    description: "Supabase CLI",
    homepage: "https://supabase.com/",
    license: "MIT",
    architecture: {
      "64bit": {
        url: `${baseUrl}/${amd64Tar}`,
        hash: amd64Hash,
      },
      arm64: {
        url: `${baseUrl}/${arm64Tar}`,
        hash: arm64Hash,
      },
    },
    bin: "supabase.exe",
    checkver: {
      github: `https://github.com/${repo}`,
    },
    autoupdate: {
      architecture: {
        "64bit": {
          url: `https://github.com/${repo}/releases/download/v$version/supabase_windows_amd64.tar.gz`,
        },
        arm64: {
          url: `https://github.com/${repo}/releases/download/v$version/supabase_windows_arm64.tar.gz`,
        },
      },
      hash: {
        url: "$baseurl/supabase_$version_checksums.txt",
      },
    },
  };
  const manifestFileName = `${name}.json`;
  const manifestJson = `${Formatter.formatJson(manifest, { space: 4 })}\n`;
  const manifestOut = path.join(distDir, manifestFileName);
  yield* fs
    .writeFileString(manifestOut, manifestJson)
    .pipe(Effect.mapError((cause) => fail("write manifest", cause)));
  yield* output(`Manifest written to ${manifestOut}`);

  if (local || dryRun) {
    yield* output(manifestJson);
    return;
  }

  const hasStagedChanges = (repoDir: string, repoPath: string) =>
    shell("inspect staged changes", () =>
      $`git -C ${repoDir} diff --cached --quiet --exit-code -- ${repoPath}`.nothrow(),
    ).pipe(
      Effect.flatMap((diff) =>
        diff.exitCode === 0
          ? Effect.succeed(false)
          : diff.exitCode === 1
            ? Effect.succeed(true)
            : Effect.fail(fail("inspect staged changes", `Failed to inspect ${repoPath}`)),
      ),
    );

  const tmpDir = yield* fs
    .makeTempDirectory({ prefix: "scoop-bucket-" })
    .pipe(Effect.mapError((cause) => fail("create temporary directory", cause)));
  yield* Effect.gen(function* () {
    const bucketUrl = `https://github.com/${bucket}.git`;
    yield* shell("clone Scoop bucket", () => $`git clone ${bucketUrl} ${tmpDir}`);
    const bucketManifestPath = path.join(tmpDir, manifestFileName);
    yield* fs
      .writeFileString(bucketManifestPath, manifestJson)
      .pipe(Effect.mapError((cause) => fail("write bucket manifest", cause)));
    yield* shell("stage manifest", () => $`git -C ${tmpDir} add ${manifestFileName}`);
    if (yield* hasStagedChanges(tmpDir, manifestFileName)) {
      yield* shell("commit manifest", () => $`git -C ${tmpDir} commit -m ${name + " " + version}`);
      yield* shell("push manifest", () => $`git -C ${tmpDir} push`);
      yield* output(`Pushed manifest update to ${bucket}`);
    } else {
      yield* output(`Manifest ${manifestFileName} is already up to date in ${bucket}`);
    }
  }).pipe(Effect.ensuring(fs.remove(tmpDir, { recursive: true, force: true }).pipe(Effect.ignore)));
});

if (import.meta.main) {
  await Effect.runPromise(
    main.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, BunPath.layer))),
  ).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
