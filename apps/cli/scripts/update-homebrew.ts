#!/usr/bin/env bun
import { $ } from "bun";
import { BunPath, BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Layer } from "effect";
import * as EffectPath from "effect/Path";
import { parseArgs } from "node:util";

class HomebrewUpdateError extends Data.TaggedError("HomebrewUpdateError")<{
  readonly operation: string;
  readonly cause: string;
}> {}

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const fail = (operation: string, cause: unknown) =>
  new HomebrewUpdateError({ operation, cause: causeMessage(cause) });

const shell = <A>(operation: string, command: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: command, catch: (cause) => fail(operation, cause) });

const output = (message: string) => Effect.sync(() => process.stdout.write(`${message}\n`));

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    repo: { type: "string", default: "supabase/cli" },
    tap: { type: "string", default: "supabase/homebrew-tap" },
    name: { type: "string", default: "supabase" },
    local: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const version = values.version;
if (!version) {
  process.stderr.write(
    "Usage: bun run scripts/update-homebrew.ts --version <version> [--repo <owner/repo>] [--tap <owner/repo>] [--name <formula-name>] [--local] [--dry-run]\n",
  );
  process.exit(1);
}

const repo = values.repo ?? "supabase/cli";
const tap = values.tap ?? "supabase/homebrew-tap";
const name = values.name ?? "supabase";
const local = values.local ?? false;
const dryRun = values["dry-run"] ?? false;

const installBlock = [
  `    bin.install "supabase"`,
  `    bin.install "supabase-go" if File.exist?("supabase-go")`,
].join("\n");
const testInvocation = `#{bin}/supabase`;

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
  const className = name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
  const baseUrl = local
    ? `file://${distDir}`
    : `https://github.com/${repo}/releases/download/v${version}`;
  const darwinArmSha = yield* sha(`supabase_${version}_darwin_arm64.tar.gz`);
  const darwinX64Sha = yield* sha(`supabase_${version}_darwin_amd64.tar.gz`);
  const linuxArmSha = yield* sha(`supabase_${version}_linux_arm64.tar.gz`);
  const linuxX64Sha = yield* sha(`supabase_${version}_linux_amd64.tar.gz`);
  const formula = `class ${className} < Formula
  desc "Supabase CLI"
  homepage "https://supabase.com"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${baseUrl}/supabase_${version}_darwin_arm64.tar.gz"
      sha256 "${darwinArmSha}"
    else
      url "${baseUrl}/supabase_${version}_darwin_amd64.tar.gz"
      sha256 "${darwinX64Sha}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${baseUrl}/supabase_${version}_linux_arm64.tar.gz"
      sha256 "${linuxArmSha}"
    else
      url "${baseUrl}/supabase_${version}_linux_amd64.tar.gz"
      sha256 "${linuxX64Sha}"
    end
  end

  def install
${installBlock}
  end

  test do
    assert_match version.to_s, shell_output("${testInvocation} --version")
  end
end
`;
  const formulaFileName = `${name}.rb`;
  const formulaOut = path.join(distDir, formulaFileName);
  yield* fs
    .writeFileString(formulaOut, formula)
    .pipe(Effect.mapError((cause) => fail("write formula", cause)));
  yield* output(`Formula written to ${formulaOut}`);

  if (local || dryRun) {
    yield* output(formula);
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
    .makeTempDirectory({ prefix: "homebrew-tap-" })
    .pipe(Effect.mapError((cause) => fail("create temporary directory", cause)));
  yield* Effect.gen(function* () {
    const tapUrl = `https://github.com/${tap}.git`;
    yield* shell("clone Homebrew tap", () => $`git clone ${tapUrl} ${tmpDir}`);
    const formulaDir = path.join(tmpDir, "Formula");
    yield* fs
      .makeDirectory(formulaDir, { recursive: true })
      .pipe(Effect.mapError((cause) => fail("create formula directory", cause)));
    const tapFormulaPath = path.join(formulaDir, formulaFileName);
    const tapFormulaRepoPath = `Formula/${formulaFileName}`;
    yield* fs
      .writeFileString(tapFormulaPath, formula)
      .pipe(Effect.mapError((cause) => fail("write tap formula", cause)));
    yield* shell("stage formula", () => $`git -C ${tmpDir} add ${tapFormulaRepoPath}`);
    if (yield* hasStagedChanges(tmpDir, tapFormulaRepoPath)) {
      yield* shell("commit formula", () => $`git -C ${tmpDir} commit -m ${name + " " + version}`);
      yield* shell("push formula", () => $`git -C ${tmpDir} push`);
      yield* output(`Pushed formula update to ${tap}`);
    } else {
      yield* output(`Formula ${formulaFileName} is already up to date in ${tap}`);
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
