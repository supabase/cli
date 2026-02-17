import { $ } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    repo: { type: "string", default: "supabase/supa" },
    tap: { type: "string", default: "supabase/homebrew-tap" },
    local: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const version = values.version;
if (!version) {
  console.error(
    "Usage: bun run scripts/update-homebrew.ts --version <version> [--repo <owner/repo>] [--tap <owner/repo>] [--local] [--dry-run]",
  );
  process.exit(1);
}

const repo = values.repo!;
const tap = values.tap!;
const local = values.local!;
const dryRun = values["dry-run"]!;
const root = path.resolve(import.meta.dir, "../../..");
const distDir = path.join(root, "dist");

// Parse checksums
const checksums = new Map<string, string>();
const checksumsText = await readFile(path.join(distDir, "checksums.txt"), "utf-8");
for (const line of checksumsText.trim().split("\n")) {
  const [hash, file] = line.split(/\s+/);
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

const formula = `class Supabase < Formula
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
    bin.install "supabase"
    bin.install "supabase-backend"
  end

  test do
    assert_match version.to_s, shell_output("\#{bin}/supabase --version")
  end
end
`;

const formulaOut = path.join(distDir, "supabase.rb");
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

  const tapFormulaPath = path.join(tmpDir, "Formula", "supabase.rb");
  await writeFile(tapFormulaPath, formula);

  await $`git -C ${tmpDir} add Formula/supabase.rb`;
  await $`git -C ${tmpDir} commit -m ${"supabase " + version}`;
  await $`git -C ${tmpDir} push`;

  console.log(`Pushed formula update to ${tap}`);
} finally {
  await rm(tmpDir, { recursive: true });
}
