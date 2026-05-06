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

// Convert name (e.g. "supabase-shim-poc") to the Ruby class name
// Homebrew expects (e.g. "SupabaseShimPoc").
const className = name
  .split(/[-_]/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
  .join("");

// When name != "supabase", rename the main binary on install so it doesn't
// clash with the official `supabase` CLI a user may already have installed.
//
// `supabase-go` is the Go sidecar the legacy shell spawns via
// apps/cli/src/shared/legacy/go-proxy.layer.ts. It is looked up by exact
// filename colocated with process.execPath, so we MUST install it with its
// original name (not renamed) right next to the SFE. The `if File.exist?`
// guard makes the formula work for both the `legacy` shell (ships both
// binaries) and the future `next` shell (SFE only).
const installLines = [
  name === "supabase" ? `    bin.install "supabase"` : `    bin.install "supabase" => "${name}"`,
  `    bin.install "supabase-go" if File.exist?("supabase-go")`,
];
const installBlock = installLines.join("\n");

const testInvocation = `#{bin}/${name}`;

// Parse checksums
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

// Clone tap repo, update formula, commit, push
const tmpDir = await mkdtemp(path.join(tmpdir(), "homebrew-tap-"));
try {
  await $`gh repo clone ${tap} ${tmpDir}`;

  const formulaDir = path.join(tmpDir, "Formula");
  await $`mkdir -p ${formulaDir}`;
  const tapFormulaPath = path.join(formulaDir, formulaFileName);
  await writeFile(tapFormulaPath, formula);

  await $`git -C ${tmpDir} add Formula/${formulaFileName}`;
  await $`git -C ${tmpDir} commit -m ${name + " " + version}`;
  await $`git -C ${tmpDir} push`;

  console.log(`Pushed formula update to ${tap}`);
} finally {
  await rm(tmpDir, { recursive: true });
}
