import { $ } from "bun";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Console, Data, Effect, FileSystem, Layer, Path } from "effect";
import { homebrewClassName, homebrewConflictsLine } from "./release-channels.ts";

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

class ShellFailed extends Data.TaggedError("ShellFailed")<{ readonly cause: unknown }> {}

class FormulaError extends Data.TaggedError("FormulaError")<{ readonly message: string }> {}

const shell = <A>(command: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: command, catch: (cause) => new ShellFailed({ cause }) });

const main = Effect.gen(function* () {
  const version = values.version;
  if (!version) {
    yield* Console.error(
      "Usage: bun run scripts/update-homebrew.ts --version <version> [--repo <owner/repo>] [--tap <owner/repo>] [--name <formula-name>] [--local] [--dry-run]",
    );
    return yield* Effect.sync(() => process.exit(1));
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = values.repo!;
  const tap = values.tap!;
  const name = values.name!;
  const local = values.local!;
  const dryRun = values["dry-run"]!;
  const root = path.resolve(import.meta.dir, "../../..");
  const distDir = path.join(root, "dist");

  // The class and filename vary by channel (e.g. "supabase-beta" -> "SupabaseBeta", "supabase@2" ->
  // "SupabaseAT2"), but the installed binary is always `supabase`.
  const className = homebrewClassName(name);

  // The Go sidecar is looked up by exact filename next to the running binary, so it must install
  // under its original name; `if File.exist?` keeps the formula working when a build ships only
  // the CLI binary.
  const installBlock = [
    `    bin.install "supabase"`,
    `    bin.install "supabase-go" if File.exist?("supabase-go")`,
  ].join("\n");

  const conflictsBlock = homebrewConflictsLine(name);
  const conflictsSection = conflictsBlock ? `${conflictsBlock}\n\n` : "";

  const testInvocation = `#{bin}/supabase`;

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
    if (!hash) return yield* new FormulaError({ message: `Checksum not found for ${file}` });
    return hash;
  });

  const baseUrl = local
    ? `file://${distDir}`
    : `https://github.com/${repo}/releases/download/v${version}`;

  const formula = `class ${className} < Formula
  desc "Supabase CLI"
  homepage "https://supabase.com"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${baseUrl}/supabase_${version}_darwin_arm64.tar.gz"
      sha256 "${yield* sha(`supabase_${version}_darwin_arm64.tar.gz`)}"
    else
      url "${baseUrl}/supabase_${version}_darwin_amd64.tar.gz"
      sha256 "${yield* sha(`supabase_${version}_darwin_amd64.tar.gz`)}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${baseUrl}/supabase_${version}_linux_arm64.tar.gz"
      sha256 "${yield* sha(`supabase_${version}_linux_arm64.tar.gz`)}"
    else
      url "${baseUrl}/supabase_${version}_linux_amd64.tar.gz"
      sha256 "${yield* sha(`supabase_${version}_linux_amd64.tar.gz`)}"
    end
  end

${conflictsSection}  def install
${installBlock}
  end

  test do
    assert_match version.to_s, shell_output("${testInvocation} --version")
  end
end
`;

  const formulaFileName = `${name}.rb`;
  const formulaOut = path.join(distDir, formulaFileName);
  yield* fs.writeFileString(formulaOut, formula);
  yield* Console.log(`Formula written to ${formulaOut}`);

  if (local || dryRun) {
    yield* Console.log(formula);
    return yield* Effect.sync(() => process.exit(0));
  }

  const hasStagedChanges = Effect.fnUntraced(function* (repoDir: string, repoPath: string) {
    const diff = yield* shell(() =>
      $`git -C ${repoDir} diff --cached --quiet --exit-code -- ${repoPath}`.nothrow(),
    );
    if (diff.exitCode === 0) return false;
    if (diff.exitCode === 1) return true;
    return yield* new FormulaError({ message: `Failed to inspect staged changes for ${repoPath}` });
  });

  const publishToTap = (tmpDir: string) =>
    Effect.gen(function* () {
      const tapUrl = `https://github.com/${tap}.git`;
      yield* shell(() => $`git clone ${tapUrl} ${tmpDir}`);

      const formulaDir = path.join(tmpDir, "Formula");
      yield* shell(() => $`mkdir -p ${formulaDir}`);
      const tapFormulaPath = path.join(formulaDir, formulaFileName);
      const tapFormulaRepoPath = `Formula/${formulaFileName}`;
      yield* fs.writeFileString(tapFormulaPath, formula);

      yield* shell(() => $`git -C ${tmpDir} add ${tapFormulaRepoPath}`);
      if (yield* hasStagedChanges(tmpDir, tapFormulaRepoPath)) {
        yield* shell(() => $`git -C ${tmpDir} commit -m ${name + " " + version}`);
        yield* shell(() => $`git -C ${tmpDir} push`);
        yield* Console.log(`Pushed formula update to ${tap}`);
      } else {
        yield* Console.log(`Formula ${formulaFileName} is already up to date in ${tap}`);
      }
    });
  /* A failed removal replaces the run's outcome. */
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "homebrew-tap-" });
      const outcome = yield* Effect.exit(restore(publishToTap(tmpDir)));
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
