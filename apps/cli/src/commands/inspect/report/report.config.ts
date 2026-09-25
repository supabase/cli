import { Effect, type FileSystem, Match, Option, type Path, Predicate } from "effect";
import * as SmolToml from "smol-toml";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import {
  configEnvOption,
  envRefName,
  envRefValue,
  loadProjectEnv,
} from "../../../command-internal/db-config.toml-read.ts";
import type { InspectRule } from "./report.rules.ts";

type RawDoc = { readonly [key: string]: unknown };

const NO_RULES: ReadonlyArray<InspectRule> = [];

function asRecord(value: unknown): RawDoc | undefined {
  return Predicate.isObject(value) ? value : undefined;
}

/**
 * Coerces a rule field to a string: numbers/bigints become their decimal string, booleans
 * become `"1"`/`"0"`, a missing field is `""`, and anything else (a nested table, array, or
 * datetime) returns `undefined` so the caller can fail with `DbConfigLoadError`.
 */
function coerceRuleField(value: unknown): string | undefined {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  return undefined;
}

/**
 * Reads `[experimental.inspect.rules]` from `<workdir>/supabase/config.toml`; when present and
 * non-empty, these rules replace the embedded defaults. A missing file yields `[]`; a malformed
 * file fails with `DbConfigLoadError`. Each field goes through `env(VAR)` expansion against the
 * shell environment, then the project `.env` files.
 */
export const readInspectRules = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const configPath = path.join(workdir, "supabase", "config.toml");

  const content = yield* fs.readFileString(configPath).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catchTag("PlatformError", (error) =>
      Match.value(error.reason).pipe(
        Match.tag("NotFound", () => Effect.void),
        Match.orElse(() =>
          Effect.fail(
            new DbConfigLoadError({
              message: `failed to read file config: ${error.message}`,
            }),
          ),
        ),
      ),
    ),
  );

  if (content === undefined) return NO_RULES;

  const doc = yield* Effect.try({
    try: () => asRecord(SmolToml.parse(content)),
    catch: (cause) =>
      new DbConfigLoadError({
        message: `failed to load config: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

  const inspect = asRecord(asRecord(doc?.["experimental"])?.["inspect"]);
  const rawRules = inspect?.["rules"];

  // A single table wraps into one rule entry; an empty table yields no rules. A scalar also
  // wraps into an entry, which fails the table check below.
  let entries: ReadonlyArray<unknown>;
  if (rawRules === undefined) {
    return NO_RULES;
  } else if (Array.isArray(rawRules)) {
    entries = rawRules;
  } else {
    const asMap = asRecord(rawRules);
    if (asMap !== undefined && Object.keys(asMap).length === 0) {
      return NO_RULES;
    }
    entries = [rawRules];
  }
  if (entries.length === 0) return NO_RULES;

  const RULE_FIELDS = ["query", "name", "pass", "fail"] as const;

  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const expandEnv = Effect.fnUntraced(function* (value: string) {
    const name = envRefName(value);
    if (name === undefined) return value;
    const fromEnv = yield* configEnvOption(name);
    return envRefValue(
      value,
      Option.getOrElse(fromEnv, () => projectEnv[name]),
    );
  });

  const rules: Array<InspectRule> = [];
  for (let index = 0; index < entries.length; index++) {
    const record = asRecord(entries[index]);
    // Rejects a non-table entry (e.g. `rules = ["foo"]`) instead of silently skipping it.
    if (record === undefined) {
      return yield* new DbConfigLoadError({
        message: `failed to load config: experimental.inspect.rules[${index}] expected a map or struct`,
      });
    }
    // An unknown or misspelled key aborts the whole load instead of being ignored.
    const unknownKeys = Object.keys(record).filter(
      (key) => !RULE_FIELDS.some((field) => field === key),
    );
    if (unknownKeys.length > 0) {
      return yield* new DbConfigLoadError({
        message: `failed to load config: experimental.inspect.rules[${index}] has invalid keys: ${unknownKeys.join(", ")}`,
      });
    }
    const readField = Effect.fnUntraced(function* (field: (typeof RULE_FIELDS)[number]) {
      const coerced = coerceRuleField(record[field]);
      if (coerced === undefined) {
        return yield* new DbConfigLoadError({
          message: `failed to load config: experimental.inspect.rules[${index}].${field} expected a string`,
        });
      }
      return yield* expandEnv(coerced);
    });
    rules.push({
      query: yield* readField("query"),
      name: yield* readField("name"),
      pass: yield* readField("pass"),
      fail: yield* readField("fail"),
    });
  }
  return rules;
});
