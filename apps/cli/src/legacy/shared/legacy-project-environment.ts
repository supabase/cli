import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProjectEnvironment } from "@supabase/config";

/**
 * Fills the gap between `@supabase/config`'s `loadProjectEnvironment` and Go's
 * `loadNestedEnv` (`apps/cli-go/pkg/config/config.go:1169-1190`). Go's version
 * walks not just `supabase/` but one directory further, up to the project
 * root/workdir (the loop stops once `cwd == filepath.Dir(repoDir)`, i.e. after
 * exactly two directories: `supabase/`, then its parent), and at each
 * directory calls `loadDefaultEnv` (`config.go:1192-1207`), which loads dotenv
 * files chosen by `SUPABASE_ENV` (empty/unset defaults to `"development"`,
 * `config.go:1193-1195`): `.env.<env>.local`, `.env.local` (skipped when
 * `env === "test"`), `.env.<env>`, `.env` — via `godotenv.Load`, which only
 * sets a key if it isn't already present in the process environment
 * (`godotenv@v1.5.1/godotenv.go:184-204`, `overload: false`). Because
 * `godotenv.Load` writes straight into the process env as it goes, the net
 * precedence (highest first) is: ambient shell env > `supabase/`-dir dotenv
 * files (`.local` variant before non-local, env-specific before bare `.env`)
 * > project-root dotenv files (same internal order).
 *
 * `loadProjectEnvironment` only implements the `supabase/`-dir, plain
 * `.env`/`.env.local` half of this (no project-root pass, no `SUPABASE_ENV`
 * filename selection) — and it's shared infrastructure used well beyond
 * `legacy/` (the `next/` command tree, `secrets set`), so extending its
 * file-resolution semantics is out of scope for a `stop`/`status` port.
 * Instead, this fills in the missing project-root + `SUPABASE_ENV`-selected
 * files locally: `loadProjectEnvironment`'s already-resolved `values` (its
 * ambient-wins-over-`supabase/.env`(.local) result) always takes precedence
 * over anything discovered here, since it's already correct for the keys it
 * knows about.
 */
function candidateDotenvFilenames(env: string): ReadonlyArray<string> {
  return [`.env.${env}.local`, ...(env === "test" ? [] : [".env.local"]), `.env.${env}`, ".env"];
}

/**
 * Minimal `KEY=VALUE` dotenv reader, intentionally not reusing
 * `@supabase/config`'s Effect-based `FileSystem` parser: this module stays a
 * plain synchronous helper (like `legacy-local-config-values.ts`'s
 * `loadFirstSigningKey`) since it only needs a handful of extra files read
 * once per `stop`/`status` invocation. Quoting/escaping matches
 * `packages/config/src/project.ts`'s `parseDotEnv` closely enough for the env
 * vars this is used for (`SUPABASE_PROJECT_ID`, `SUPABASE_AUTH_*`), which
 * never need the full dotenv spec (multiline values, `export` re-declares).
 */
function readDotEnvFile(path: string): Record<string, string> | undefined {
  if (!existsSync(path)) return undefined;

  const contents = readFileSync(path, "utf8");
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r\n?|\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([\w.-]+)\s*=(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    if (key === undefined) continue;

    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      }
    } else {
      const commentIndex = value.indexOf("#");
      if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
    }

    values[key] = value;
  }

  return values;
}

/**
 * Returns the merged env-var map `stop`/`status` should read `SUPABASE_*`
 * overrides (project id, auth fields) from — `projectEnv.values` (ambient +
 * `supabase/.env`(.local), already correct) layered over the project-root and
 * `SUPABASE_ENV`-selected files `loadProjectEnvironment` doesn't cover.
 * Returns `undefined` when `projectEnv` is `null` (no `supabase/` project
 * found), matching callers' existing "fall back to `process.env` directly"
 * behavior.
 */
export function legacyResolveProjectEnvironmentValues(
  projectEnv: ProjectEnvironment | null,
): Record<string, string> | undefined {
  if (projectEnv === null) return undefined;

  const env = process.env["SUPABASE_ENV"] || "development";
  const filenames = candidateDotenvFilenames(env);
  const merged: Record<string, string> = {};

  // supabase/ dir first, then its parent (the project root) — matching Go's
  // directory walk order. Within a directory, `godotenv.Load`'s "never
  // override an already-set var" means first-processed-wins, so the plain
  // merge below (skip keys already present) reproduces both orderings at once.
  for (const dir of [projectEnv.paths.supabaseDir, projectEnv.paths.projectRoot]) {
    for (const filename of filenames) {
      const parsed = readDotEnvFile(join(dir, filename));
      if (parsed === undefined) continue;
      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in merged)) merged[key] = value;
      }
    }
  }

  return { ...merged, ...projectEnv.values };
}
