import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CliProjectEnvironment } from "@supabase/config";

import { parseDotEnv } from "./dotenv.ts";

/**
 * Dotenv filenames to check, in precedence order, for a given `SUPABASE_ENV` value
 * (`.env.<env>.local`, `.env.local` — skipped for `"test"` — `.env.<env>`, `.env`).
 *
 * Fills a gap in `@supabase/config`'s `loadCliProjectEnvironment`, which only resolves this
 * order for the `supabase/` directory: this module also checks the project root, and applies
 * `SUPABASE_ENV`-selected filenames there too. Its own resolved values still take precedence
 * over anything found here, since it's already correct for the keys it knows about.
 */
export function candidateDotenvFilenames(env: string): ReadonlyArray<string> {
  return [`.env.${env}.local`, ...(env === "test" ? [] : [".env.local"]), `.env.${env}`, ".env"];
}

/**
 * Reads and parses a dotenv file, or `undefined` if it doesn't exist. Delegates to
 * {@link parseDotEnv} rather than a hand-rolled line scanner, so a quoted value spanning
 * physical lines (a PEM/private key) parses correctly.
 *
 * @throws on a malformed line (not blank, a comment, or a `KEY=VALUE`/`KEY: VALUE`
 * assignment) — the caller must fail rather than silently skip it.
 */
function readDotEnvFile(path: string): Record<string, string> | undefined {
  if (!existsSync(path)) return undefined;

  const contents = readFileSync(path, "utf8");
  try {
    return parseDotEnv(contents);
  } catch (cause) {
    throw new Error(
      `failed to parse environment file: ${path} (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
}

/**
 * Merged env-var map for `stop`/`status` to read `SUPABASE_*` overrides from, covering the
 * project-root and `SUPABASE_ENV`-selected files {@link candidateDotenvFilenames} adds beyond
 * `loadCliProjectEnvironment`.
 *
 * Only `projectEnv`'s ambient-sourced entries are layered back on top: its other, file-derived
 * entries aren't necessarily higher-precedence than the env-specific files resolved here, and
 * it has no notion of those filenames to tell the two apart itself.
 *
 * `projectEnv` is `null` when no config file was found, but dotenv loading isn't gated on
 * that — fall back to deriving `<workdir>/supabase` and `workdir` directly, with `process.env`
 * as the ambient layer.
 */
export function resolveProjectEnvironmentValues(
  projectEnv: CliProjectEnvironment | null,
  workdir: string,
): Record<string, string> {
  const env = process.env["SUPABASE_ENV"] || "development";
  const filenames = candidateDotenvFilenames(env);
  const merged: Record<string, string> = {};

  const supabaseDir = projectEnv?.paths.supabaseDir ?? join(workdir, "supabase");
  const projectRoot = projectEnv?.paths.projectRoot ?? workdir;

  // supabase/ dir first, then its parent (the project root). Within a directory,
  // "never override an already-set var" means first-processed-wins, so skipping keys
  // already present reproduces both orderings at once.
  for (const dir of [supabaseDir, projectRoot]) {
    for (const filename of filenames) {
      const parsed = readDotEnvFile(join(dir, filename));
      if (parsed === undefined) continue;
      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in merged)) merged[key] = value;
      }
    }
  }

  const ambientOverrides: Record<string, string> = {};
  if (projectEnv !== null) {
    for (const [key, value] of Object.entries(projectEnv.values)) {
      if (projectEnv.sources[key] === "ambient") {
        ambientOverrides[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        ambientOverrides[key] = value;
      }
    }
  }

  return { ...merged, ...ambientOverrides };
}
