import { Effect, type FileSystem, type Path } from "effect";
import * as SmolToml from "smol-toml";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import { expandEnv, loadProjectEnv } from "../../../command-internal/db-config.toml-read.ts";
import type { InspectRule } from "./report.rules.ts";

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
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
      error.reason._tag === "NotFound"
        ? Effect.succeed(undefined)
        : Effect.fail(
            new DbConfigLoadError({
              message: `failed to read file config: ${error.message}`,
            }),
          ),
    ),
  );

  if (content === undefined) return [] as ReadonlyArray<InspectRule>;

  let doc: RawDoc | undefined;
  try {
    doc = asRecord(SmolToml.parse(content));
  } catch (cause) {
    return yield* Effect.fail(
      new DbConfigLoadError({
        message: `failed to load config: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    );
  }

  const inspect = asRecord(asRecord(doc?.["experimental"])?.["inspect"]);
  const rawRules = inspect?.["rules"];

  // A single table wraps into one rule entry; an empty table yields no rules. A scalar also
  // wraps into an entry, which fails the table check below.
  let entries: ReadonlyArray<unknown>;
  if (rawRules === undefined) {
    return [] as ReadonlyArray<InspectRule>;
  } else if (Array.isArray(rawRules)) {
    entries = rawRules;
  } else {
    const asMap = asRecord(rawRules);
    if (asMap !== undefined && Object.keys(asMap).length === 0) {
      return [] as ReadonlyArray<InspectRule>;
    }
    entries = [rawRules];
  }
  if (entries.length === 0) return [] as ReadonlyArray<InspectRule>;

  const RULE_FIELDS = ["query", "name", "pass", "fail"] as const;

  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const lookup = (name: string): string | undefined => process.env[name] ?? projectEnv[name];

  const rules: Array<InspectRule> = [];
  for (let index = 0; index < entries.length; index++) {
    const record = asRecord(entries[index]);
    // Rejects a non-table entry (e.g. `rules = ["foo"]`) instead of silently skipping it.
    if (record === undefined) {
      return yield* Effect.fail(
        new DbConfigLoadError({
          message: `failed to load config: experimental.inspect.rules[${index}] expected a map or struct`,
        }),
      );
    }
    // An unknown or misspelled key aborts the whole load instead of being ignored.
    const unknownKeys = Object.keys(record).filter(
      (key) => !(RULE_FIELDS as ReadonlyArray<string>).includes(key),
    );
    if (unknownKeys.length > 0) {
      return yield* Effect.fail(
        new DbConfigLoadError({
          message: `failed to load config: experimental.inspect.rules[${index}] has invalid keys: ${unknownKeys.join(", ")}`,
        }),
      );
    }
    const fields: Record<string, string> = {};
    for (const field of RULE_FIELDS) {
      const coerced = coerceRuleField(record[field]);
      if (coerced === undefined) {
        return yield* Effect.fail(
          new DbConfigLoadError({
            message: `failed to load config: experimental.inspect.rules[${index}].${field} expected a string`,
          }),
        );
      }
      fields[field] = expandEnv(coerced, lookup);
    }
    rules.push({
      query: fields["query"]!,
      name: fields["name"]!,
      pass: fields["pass"]!,
      fail: fields["fail"]!,
    });
  }
  return rules as ReadonlyArray<InspectRule>;
});
