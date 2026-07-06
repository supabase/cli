import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProjectEnvironment } from "@supabase/config";

import { stripInlineComment } from "./legacy-dotenv.ts";

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

// Mirrors godotenv's `expandVariables` (`godotenv@v1.5.1/parser.go:253,257-271`): substitutes
// `$VAR`/`${VAR}` using only keys already parsed earlier in *this* file (godotenv re-parses
// each dotenv file into its own fresh map — it never sees a different file's keys or the
// ambient shell env, `parser.go:20-45`). Called for unquoted and double-quoted values only
// (`parser.go:157,174-178`); single-quoted values never reach this (`parser.go:172-173`). An
// unresolved reference expands to `""` (Go's zero value for a missing map key), not the
// literal `$NAME`.
function expandDotEnvVariable(value: string, values: Readonly<Record<string, string>>): string {
  return value.replace(
    /\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g,
    (_match, braced: string | undefined, bare: string | undefined) =>
      values[braced ?? bare ?? ""] ?? "",
  );
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
 *
 * @throws on a line that isn't blank, a comment, or a `KEY=VALUE` assignment —
 * matching Go's `loadEnvIfExists` (`pkg/config/config.go:1209-1234`), which
 * propagates `godotenv.Load`'s parse error up through `loadNestedEnv` and fails
 * `Config.Load` before `stop`/`status` touch Docker, rather than silently
 * skipping the bad line. Mirrors `packages/config/src/project.ts`'s
 * `parseDotEnv`, which already fails the same way for `supabase/.env`(.local).
 */
function readDotEnvFile(path: string): Record<string, string> | undefined {
  if (!existsSync(path)) return undefined;

  const contents = readFileSync(path, "utf8");
  const values: Record<string, string> = {};
  const lines = contents.split(/\r\n?|\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([\w.-]+)\s*=(.*)$/.exec(line);
    if (match === null) {
      throw new Error(`failed to parse environment file: ${path} (line ${index + 1})`);
    }
    const key = match[1];
    if (key === undefined) continue;

    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
        value = expandDotEnvVariable(value, values);
      }
    } else {
      // godotenv only starts a comment at a `#` preceded by whitespace (see
      // `stripInlineComment`'s doc comment); an unquoted `#bar` with no leading
      // space is part of the value, e.g. `SUPABASE_PROJECT_ID=foo#bar`.
      value = stripInlineComment(value).trim();
      value = expandDotEnvVariable(value, values);
    }

    values[key] = value;
  }

  return values;
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

  const ambientOverrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(projectEnv.values)) {
    if (projectEnv.sources[key] === "ambient") {
      ambientOverrides[key] = value;
    }
  }

  return { ...merged, ...ambientOverrides };
}
