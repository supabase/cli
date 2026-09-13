import { $ } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

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
  console.error(
    "Usage: bun run scripts/update-homebrew.ts --version <version> [--repo <owner/repo>] [--tap <owner/repo>] [--name <formula-name>] [--local] [--dry-run]",
  );
  process.exit(1);
}

const repo = values.repo!;
const tap = values.tap!;
const name = values.name!;
const local = values.local!;
const dryRun = values["dry-run"]!;
const root = path.resolve(import.meta.dir, "../../..");
const distDir = path.join(root, "dist");

// Converts name (e.g. "supabase-beta") to the Ruby class Homebrew expects (e.g. "SupabaseBeta").
// The class and filename vary by channel, but the installed binary is always `supabase`.
const className = name
  .split(/[-_]/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
  .join("");

// The Go sidecar is looked up by exact filename next to the running binary, so it must install
// under its original name; `if File.exist?` keeps the formula working when a build ships only
// the CLI binary.
const installBlock = [
  `    bin.install "supabase"`,
  `    bin.install "supabase-go" if File.exist?("supabase-go")`,
].join("\n");

const testInvocation = `#{bin}/supabase`;

const checksums = new Map<string, string>();
const checksumsText = await readFile(path.join(distDir, "checksums.txt"), "utf-8");
for (const line of checksumsText.trim().split("\n")) {
  const [hash, file] = line.split(/\s+/) as [string, string];
  checksums.set(file, hash);
}

function sha(file: string): string {
  const hash = checksums.get(file);
  if (!hash) throw new Error(`Checksum not found for ${file}`);
  return hash;
}

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
      sha256 "${sha(`supabase_${version}_darwin_arm64.tar.gz`)}"
    else
      url "${baseUrl}/supabase_${version}_darwin_amd64.tar.gz"
      sha256 "${sha(`supabase_${version}_darwin_amd64.tar.gz`)}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${baseUrl}/supabase_${version}_linux_arm64.tar.gz"
      sha256 "${sha(`supabase_${version}_linux_arm64.tar.gz`)}"
    else
      url "${baseUrl}/supabase_${version}_linux_amd64.tar.gz"
      sha256 "${sha(`supabase_${version}_linux_amd64.tar.gz`)}"
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
await writeFile(formulaOut, formula);
console.log(`Formula written to ${formulaOut}`);

if (local || dryRun) {
  console.log(formula);
  process.exit(0);
}

async function hasStagedChanges(repoDir: string, repoPath: string): Promise<boolean> {
  const diff =
    await $`git -C ${repoDir} diff --cached --quiet --exit-code -- ${repoPath}`.nothrow();
  if (diff.exitCode === 0) return false;
  if (diff.exitCode === 1) return true;
  throw new Error(`Failed to inspect staged changes for ${repoPath}`);
}

const tmpDir = await mkdtemp(path.join(tmpdir(), "homebrew-tap-"));
try {
  const tapUrl = `https://github.com/${tap}.git`;
  await $`git clone ${tapUrl} ${tmpDir}`;

  const formulaDir = path.join(tmpDir, "Formula");
  await $`mkdir -p ${formulaDir}`;
  const tapFormulaPath = path.join(formulaDir, formulaFileName);
  const tapFormulaRepoPath = `Formula/${formulaFileName}`;
  await writeFile(tapFormulaPath, formula);

  await $`git -C ${tmpDir} add ${tapFormulaRepoPath}`;
  if (await hasStagedChanges(tmpDir, tapFormulaRepoPath)) {
    await $`git -C ${tmpDir} commit -m ${name + " " + version}`;
    await $`git -C ${tmpDir} push`;
    console.log(`Pushed formula update to ${tap}`);
  } else {
    console.log(`Formula ${formulaFileName} is already up to date in ${tap}`);
  }
} finally {
  await rm(tmpDir, { recursive: true });
}
