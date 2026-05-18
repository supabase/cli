// Shared Scoop manifest builder used by both update-scoop.ts (our own
// supabase/scoop-bucket) and update-scoop-main.ts (PR to upstream
// ScoopInstaller/Main). Producing the same JSON from one place keeps
// the two buckets from drifting in URL format, hashes, or arch list.

export interface BuildScoopManifestOptions {
  version: string;
  repo: string;
  checksums: Map<string, string>;
  local?: boolean;
  distDir?: string;
}

export interface BuildScoopManifestResult {
  manifest: object;
  json: string;
}

const BIN_ENTRY = "supabase.exe";

export function buildScoopManifest(opts: BuildScoopManifestOptions): BuildScoopManifestResult {
  const { version, repo, checksums, local = false, distDir } = opts;

  if (local && !distDir) {
    throw new Error("distDir is required when local=true");
  }

  const baseUrl = local
    ? `file:///${distDir!.replace(/\\/g, "/")}`
    : `https://github.com/${repo}/releases/download/v${version}`;

  const sha = (file: string): string => {
    const hash = checksums.get(file);
    if (!hash) throw new Error(`Checksum not found for ${file}`);
    return hash;
  };

  const manifest = {
    version,
    description: "Supabase CLI",
    homepage: "https://supabase.com",
    license: "MIT",
    architecture: {
      "64bit": {
        url: `${baseUrl}/supabase_${version}_windows_amd64.zip`,
        hash: sha(`supabase_${version}_windows_amd64.zip`),
        bin: [BIN_ENTRY],
      },
      arm64: {
        url: `${baseUrl}/supabase_${version}_windows_arm64.zip`,
        hash: sha(`supabase_${version}_windows_arm64.zip`),
        bin: [BIN_ENTRY],
      },
    },
    checkver: {
      github: `https://github.com/${repo}`,
    },
    autoupdate: {
      architecture: {
        "64bit": {
          url: `https://github.com/${repo}/releases/download/v$version/supabase_$version_windows_amd64.zip`,
        },
        arm64: {
          url: `https://github.com/${repo}/releases/download/v$version/supabase_$version_windows_arm64.zip`,
        },
      },
    },
  };

  const json = `${JSON.stringify(manifest, null, 4)}\n`;
  return { manifest, json };
}

export async function readChecksums(path: string): Promise<Map<string, string>> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf-8");
  const checksums = new Map<string, string>();
  for (const line of text.trim().split("\n")) {
    const [hash, file] = line.split(/\s+/) as [string, string];
    checksums.set(file, hash);
  }
  return checksums;
}
