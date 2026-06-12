import { Effect, type FileSystem, type Path } from "effect";
import * as SmolToml from "smol-toml";
import { LegacyDbConfigLoadError } from "../../../shared/legacy-db-config.errors.ts";
import {
  legacyExpandEnv,
  legacyLoadProjectEnv,
} from "../../../shared/legacy-db-config.toml-read.ts";
import type { LegacyInspectRule } from "./report.rules.ts";

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Read `[experimental.inspect.rules]` from `<workdir>/supabase/config.toml`,
 * mirroring Go's `config.Load` (`apps/cli-go/pkg/config/config.go:236-256`): when
 * present and non-empty, these custom rules replace the embedded defaults.
 *
 * Follows the `legacyReadDbToml` policy exactly — a **missing** config file yields
 * `[]` (defaults apply), but a **malformed** file is a hard error
 * (`LegacyDbConfigLoadError`). Each rule's string fields are run through Go's
 * `LoadEnvHook` `env(VAR)` expansion (`legacyExpandEnv`), resolving against the
 * shell environment first and then the project `.env` files (Go populates the
 * process env via `loadNestedEnv` before the decode hook runs).
 *
 * `fs`/`path` are passed in so the caller controls the platform layer; the read is
 * colocated here for now and hoisted to `legacy/shared/` if a second command reads
 * `[experimental.inspect.*]`.
 */
export const legacyReadInspectRules = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const configPath = path.join(workdir, "supabase", "config.toml");

  const content = yield* fs.readFileString(configPath).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(undefined)
        : Effect.fail(
            new LegacyDbConfigLoadError({
              message: `failed to read file config: ${error.message}`,
            }),
          ),
    ),
  );

  if (content === undefined) return [] as ReadonlyArray<LegacyInspectRule>;

  let doc: RawDoc | undefined;
  try {
    doc = asRecord(SmolToml.parse(content));
  } catch (cause) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({
        message: `failed to load config: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    );
  }

  const inspect = asRecord(asRecord(doc?.["experimental"])?.["inspect"]);
  const rawRules = inspect?.["rules"];
  if (!Array.isArray(rawRules)) return [] as ReadonlyArray<LegacyInspectRule>;

  // Resolve `env(VAR)` against the shell env first, then the project `.env` files.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const lookup = (name: string): string | undefined => process.env[name] ?? projectEnv[name];

  const rules: Array<LegacyInspectRule> = [];
  for (const entry of rawRules) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    rules.push({
      query: legacyExpandEnv(asString(record["query"]), lookup),
      name: legacyExpandEnv(asString(record["name"]), lookup),
      pass: legacyExpandEnv(asString(record["pass"]), lookup),
      fail: legacyExpandEnv(asString(record["fail"]), lookup),
    });
  }
  return rules as ReadonlyArray<LegacyInspectRule>;
});
