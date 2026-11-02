import { $ } from "bun";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Console, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";

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

class ShellFailed extends Data.TaggedError("ShellFailed")<{ readonly cause: unknown }> {}

class ManifestError extends Data.TaggedError("ManifestError")<{ readonly message: string }> {}

const shell = <A>(command: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: command, catch: (cause) => new ShellFailed({ cause }) });

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 4 }));

const main = Effect.gen(function* () {
  const version = values.version;
  if (!version) {
    yield* Console.error(
      "Usage: bun run scripts/update-scoop.ts --version <version> [--repo <owner/repo>] [--bucket <owner/repo>] [--name <manifest-name>] [--local] [--dry-run]",
    );
    return yield* Effect.sync(() => process.exit(1));
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = values.repo!;
  const bucket = values.bucket!;
  const name = values.name!;
  const local = values.local!;
  const dryRun = values["dry-run"]!;

  // The shipped binary is always `supabase.exe`; only the manifest filename differs (e.g.
  // `supabase-beta.json`), so stable and beta can coexist in the same bucket.
  const binEntry = "supabase.exe";
  const root = path.resolve(import.meta.dir, "../../..");
  const distDir = path.join(root, "dist");

  const checksums = new Map<string, string>();
  const checksumsText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    yield* fs.readFile(path.join(distDir, "checksums.txt")),
  );
  for (const line of checksumsText.trim().split("\n")) {
    const [hash, file] = line.split(/\s+/) as [string, string];
    checksums.set(file, hash);
  }

  const sha = Effect.fnUntraced(function* (file: string) {
    const hash = checksums.get(file);
    if (!hash) return yield* new ManifestError({ message: `Checksum not found for ${file}` });
    return hash;
  });

  // Scoop supports file:// URLs for local testing
  const baseUrl = local
    ? `file:///${distDir.replace(/\\/g, "/")}`
    : `https://github.com/${repo}/releases/download/v${version}`;

  // Published releases use unversioned Windows tarball names (release-shared.yml copies the
  // versioned build); local builds only emit versioned archives, so --local keeps those names.
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
        hash: yield* sha(`supabase_${version}_windows_amd64.tar.gz`),
      },
      arm64: {
        url: `${baseUrl}/${arm64Tar}`,
        hash: yield* sha(`supabase_${version}_windows_arm64.tar.gz`),
      },
    },
    bin: binEntry,
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
  const manifestJson = `${yield* encodeManifest(manifest)}\n`;
  const manifestOut = path.join(distDir, manifestFileName);
  yield* fs.writeFileString(manifestOut, manifestJson);
  yield* Console.log(`Manifest written to ${manifestOut}`);

  if (local || dryRun) {
    yield* Console.log(manifestJson);
    return yield* Effect.sync(() => process.exit(0));
  }

  const hasStagedChanges = Effect.fnUntraced(function* (repoDir: string, repoPath: string) {
    const diff = yield* shell(() =>
      $`git -C ${repoDir} diff --cached --quiet --exit-code -- ${repoPath}`.nothrow(),
    );
    if (diff.exitCode === 0) return false;
    if (diff.exitCode === 1) return true;
    return yield* new ManifestError({
      message: `Failed to inspect staged changes for ${repoPath}`,
    });
  });

  const publishToBucket = (tmpDir: string) =>
    Effect.gen(function* () {
      const bucketUrl = `https://github.com/${bucket}.git`;
      yield* shell(() => $`git clone ${bucketUrl} ${tmpDir}`);

      const bucketManifestPath = path.join(tmpDir, manifestFileName);
      yield* fs.writeFileString(bucketManifestPath, manifestJson);

      yield* shell(() => $`git -C ${tmpDir} add ${manifestFileName}`);
      if (yield* hasStagedChanges(tmpDir, manifestFileName)) {
        yield* shell(() => $`git -C ${tmpDir} commit -m ${name + " " + version}`);
        yield* shell(() => $`git -C ${tmpDir} push`);
        yield* Console.log(`Pushed manifest update to ${bucket}`);
      } else {
        yield* Console.log(`Manifest ${manifestFileName} is already up to date in ${bucket}`);
      }
    });
  /* A failed removal replaces the run's outcome. */
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "scoop-bucket-" });
      const outcome = yield* Effect.exit(restore(publishToBucket(tmpDir)));
      yield* fs.remove(tmpDir, { recursive: true });
      return yield* outcome;
    }),
  );
});

function thrownValue(error: { readonly message: string; readonly cause?: unknown }): unknown {
  return error.cause !== undefined ? error.cause : new Error(error.message);
}

await Effect.runPromise(
  main.pipe(
    Effect.catch((error) => Effect.die(thrownValue(error))),
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
  ),
);
