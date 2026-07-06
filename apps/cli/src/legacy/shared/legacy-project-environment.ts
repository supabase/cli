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
//
// A leading `\` before `$` escapes the reference: godotenv's `expandVarRegex` captures that
// backslash (`parser.go:253`), and its replacer strips ONLY the backslash and returns the rest
// of the match verbatim — `\$FOO`/`\${FOO}` becomes the literal `$FOO`/`${FOO}`, never looked up
// in the map, even when `FOO` is defined (`parser.go:264-265`: `if submatch[1] == "\\" ... return
// submatch[0][1:]`). Verified directly against the real `joho/godotenv@v1.5.1` module (the version
// `apps/cli-go/go.mod` pins) rather than reasoning from the doc comment alone. The earlier
// `\n`/`\r` unescape step in {@link readDotEnvFile} only matches backslash+`n`/`r`, so an
// escaping backslash before `$` survives untouched until this function sees it, matching Go's
// own `expandEscapes` → `expandVariables` order.
function expandDotEnvVariable(value: string, values: Readonly<Record<string, string>>): string {
  return value.replace(
    /(\\)?\$(?:\{([A-Z0-9_]+)\}|([A-Z0-9_]+))?/g,
    (
      match,
      backslash: string | undefined,
      braced: string | undefined,
      bare: string | undefined,
    ) => {
      if (backslash !== undefined) return match.slice(1);
      if (braced !== undefined) return values[braced] ?? "";
      if (bare !== undefined) return values[bare] ?? "";
      return match;
    },
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
 * Accepts godotenv's `KEY: VALUE` YAML-style separator as well as `KEY=VALUE`
 * (`joho/godotenv@v1.5.1/parser.go:90-95`'s `locateKeyName` treats `=` and `:`
 * as interchangeable) — matching `packages/config/src/project.ts`'s
 * `parseDotEnv`, which already accepts both forms.
 *
 * @throws on a line that isn't blank, a comment, or a `KEY=VALUE`/`KEY: VALUE`
 * assignment — matching Go's `loadEnvIfExists` (`pkg/config/config.go:1209-1234`),
 * which propagates `godotenv.Load`'s parse error up through `loadNestedEnv` and
 * fails `Config.Load` before `stop`/`status` touch Docker, rather than silently
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

    const match = /^(?:export\s+)?([\w.-]+)\s*(?:=|:\s+)(.*)$/.exec(line);
    if (match === null) {
      throw new Error(`failed to parse environment file: ${path} (line ${index + 1})`);
    }
    const key = match[1];
    if (key === undefined) continue;

    let value = (match[2] ?? "").trim();
    const quote = value[0];
    // A value is quoted iff it STARTS with a quote — matching godotenv's
    // `extractVarValue` (`joho/godotenv@v1.5.1/parser.go:160-180`), which locates the
    // quoted span by scanning forward for the first unescaped matching quote, not by
    // requiring the whole (trimmed) remainder to end with one. Anything after that
    // closing quote (e.g. a trailing `# comment`) is discarded, so `"demo" # local`
    // parses as `demo`, not the literal `"demo"` a naive `endsWith(quote)` check would
    // produce by falling through to the unquoted branch below.
    let quoteEnd = -1;
    if (quote === '"' || quote === "'") {
      for (let i = 1; i < value.length; i++) {
        if (value[i] === quote && value[i - 1] !== "\\") {
          quoteEnd = i;
          break;
        }
      }
    }
    if (quoteEnd !== -1) {
      value = value.slice(1, quoteEnd);
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
