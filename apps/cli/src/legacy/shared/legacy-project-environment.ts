import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProjectEnvironment } from "@supabase/config";

import { parseDotEnv } from "./legacy-dotenv.ts";

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
 * Minimal dotenv reader for the project-root and `SUPABASE_ENV`-selected extra
 * files this module resolves, intentionally not reusing `@supabase/config`'s
 * Effect-based `FileSystem` parser: this module stays a plain synchronous
 * helper (like `legacy-local-config-values.ts`'s `loadFirstSigningKey`) since
 * it only needs a handful of extra files read once per `stop`/`status`
 * invocation. Delegates to {@link parseDotEnv} — the same `godotenv`-faithful,
 * cursor-based parser `bootstrap`/`legacyReadDbToml` already use — rather than
 * a hand-rolled line-by-line scan, so a quoted value spanning physical lines
 * (a PEM/private key) parses correctly instead of aborting on what looks like
 * a malformed continuation line.
 *
 * @throws on a line that isn't blank, a comment, or a `KEY=VALUE`/`KEY: VALUE`
 * assignment — matching Go's `loadEnvIfExists` (`pkg/config/config.go:1209-1234`),
 * which propagates `godotenv.Load`'s parse error up through `loadNestedEnv` and
 * fails `Config.Load` before `stop`/`status` touch Docker, rather than silently
 * skipping the bad line.
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
 * Returns the merged env-var map `stop`/`status` should read `SUPABASE_*`
 * overrides (project id, auth fields) from — the project-root and
 * `SUPABASE_ENV`-selected files `loadProjectEnvironment` doesn't cover, layered
 * under only the truly ambient-sourced entries of `projectEnv.values`.
 *
 * Only `projectEnv`'s AMBIENT entries outrank `merged`: `projectEnv.values`
 * also carries plain `supabase/.env`/`.env.local` values it read itself, and
 * those are not necessarily higher Go precedence than an env-specific file
 * (`.env.<env>.local`/`.env.<env>`) `merged` resolved — `loadProjectEnvironment`
 * has no notion of `SUPABASE_ENV`-selected filenames, so it can't tell the two
 * apart itself. `merged`'s own walk below already re-derives the full file
 * precedence, including `supabase/.env`(.local), so only ambient needs to be
 * layered back on top (`projectEnv.sources[key] === "ambient"` marks exactly
 * those entries — see `loadProjectEnvironment`'s `ProjectEnvironment` shape).
 *
 * `projectEnv` is `null` whenever `@supabase/config` found no
 * `supabase/config.toml`/`config.json` (searching ancestors, or at exactly
 * `workdir` when the caller passed `search: false`) — but Go's dotenv loading
 * doesn't share that precondition: `Config.Load` calls
 * `loadNestedEnv(builder.SupabaseDirPath)` BEFORE it ever opens `config.toml`
 * (`pkg/config/config.go:786-793`), and `SupabaseDirPath` is a pure string
 * join with no existence check (`NewPathBuilder`, `pkg/config/utils.go:43-48`).
 * So a missing/absent config file must not skip dotenv loading — fall back to
 * deriving the same two directories directly from `workdir`
 * (`<workdir>/supabase` and `workdir` itself) and read `process.env` itself as
 * the ambient layer, since there's no `loadProjectEnvironment` result to
 * consult for it in this branch.
 */
export function legacyResolveProjectEnvironmentValues(
  projectEnv: ProjectEnvironment | null,
  workdir: string,
): Record<string, string> {
  const env = process.env["SUPABASE_ENV"] || "development";
  const filenames = candidateDotenvFilenames(env);
  const merged: Record<string, string> = {};

  const supabaseDir = projectEnv?.paths.supabaseDir ?? join(workdir, "supabase");
  const projectRoot = projectEnv?.paths.projectRoot ?? workdir;

  // supabase/ dir first, then its parent (the project root) — matching Go's
  // directory walk order. Within a directory, `godotenv.Load`'s "never
  // override an already-set var" means first-processed-wins, so the plain
  // merge below (skip keys already present) reproduces both orderings at once.
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
