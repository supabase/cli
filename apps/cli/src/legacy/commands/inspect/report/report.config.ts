import { Effect, Option, type FileSystem, type Path } from "effect";
import * as SmolToml from "smol-toml";
import { LegacyDbConfigLoadError } from "../../../shared/legacy-db-config.errors.ts";
import { legacyErrorMessage } from "../../../shared/legacy-error-message.ts";
import {
  legacyExpandEnv,
  legacyLoadProjectEnv,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyViperEnv } from "../../../../shared/legacy/legacy-viper-env.ts";
import type { LegacyInspectRule } from "./report.rules.ts";

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
}

/**
 * Coerce a rule field value to a string, using weakly-typed decoding: a
 * string passes through; a number/bigint becomes its decimal string; a boolean
 * becomes `"1"`/`"0"`; a missing field is the zero value `""`. Any other type (a
 * nested table/array/datetime as a scalar field) is NOT coercible — this
 * returns `undefined` to signal the caller to fail with `LegacyDbConfigLoadError`.
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
 * Read `[experimental.inspect.rules]` from `<workdir>/supabase/config.toml`:
 * when present and non-empty, these custom rules replace the embedded defaults.
 *
 * Follows the `legacyReadDbToml` policy exactly — a **missing** config file yields
 * `[]` (defaults apply), but a **malformed** file is a hard error
 * (`LegacyDbConfigLoadError`). Each rule's string fields are run through
 * `env(VAR)` expansion (`legacyExpandEnv`), resolving against the
 * shell environment first and then the project `.env` files.
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
        ? Effect.void
        : Effect.fail(
            new LegacyDbConfigLoadError({
              message: `failed to read file config: ${error.message}`,
            }),
          ),
    ),
  );

  if (content === undefined) return [] as ReadonlyArray<LegacyInspectRule>;

  const doc = yield* Effect.try({
    try: () => asRecord(SmolToml.parse(content)),
    catch: (cause) =>
      new LegacyDbConfigLoadError({
        message: `failed to load config: ${legacyErrorMessage(cause)}`,
      }),
  });

  const inspect = asRecord(asRecord(doc?.["experimental"])?.["inspect"]);
  const rawRules = inspect?.["rules"];

  // Normalize `rules` into the list of entries to decode, using weakly-typed
  // decoding:
  //   - absent            → no custom rules (defaults apply)
  //   - array-of-tables   → decode each element as a rule
  //   - a single table    → weak-typing wraps it into a 1-element slice → one rule
  //   - an EMPTY table     → wraps into an empty slice → no custom rules (defaults)
  //   - a scalar (string/number/…) → wrapped into `[scalar]`, then decoding a scalar
  //     into a rule struct aborts ("expected a map or struct") — surfaced below.
  let entries: ReadonlyArray<unknown>;
  if (rawRules === undefined) {
    return [] as ReadonlyArray<LegacyInspectRule>;
  } else if (Array.isArray(rawRules)) {
    entries = rawRules;
  } else {
    const asMap = asRecord(rawRules);
    if (asMap !== undefined && Object.keys(asMap).length === 0) {
      return [] as ReadonlyArray<LegacyInspectRule>;
    }
    entries = [rawRules];
  }
  if (entries.length === 0) return [] as ReadonlyArray<LegacyInspectRule>;

  const RULE_FIELDS = ["query", "name", "pass", "fail"] as const;

  // Resolve `env(VAR)` against the shell env first, then the project `.env` files.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const viperEnv = yield* LegacyViperEnv;
  const expandField = (value: string) => {
    const match = /^env\((.*)\)$/u.exec(value);
    if (match === null) return Effect.succeed(value);
    const name = match[1] ?? "";
    return viperEnv.get(name).pipe(
      Effect.map((shellValue) =>
        legacyExpandEnv(
          value,
          (requested) => Option.getOrUndefined(shellValue) ?? projectEnv[requested],
        ),
      ),
      Effect.mapError(
        (cause) =>
          new LegacyDbConfigLoadError({
            message: `failed to load config environment: ${legacyErrorMessage(cause)}`,
          }),
      ),
    );
  };

  const rules: Array<LegacyInspectRule> = [];
  for (let index = 0; index < entries.length; index++) {
    const record = asRecord(entries[index]);
    // A non-table entry (e.g. `rules = ["foo"]` or `rules = "foo"`) is rejected:
    // it fails to load with "expected a map or struct" rather than being
    // silently skipped.
    if (record === undefined) {
      return yield* new LegacyDbConfigLoadError({
        message: `failed to load config: experimental.inspect.rules[${index}] expected a map or struct`,
      });
    }
    // An unknown/misspelled key in a rule table (e.g.
    // `fails = "bad"`) aborts the whole config load — there is no escape hatch.
    const unknownKeys = Object.keys(record).filter(
      (key) => !(RULE_FIELDS as ReadonlyArray<string>).includes(key),
    );
    if (unknownKeys.length > 0) {
      return yield* new LegacyDbConfigLoadError({
        message: `failed to load config: experimental.inspect.rules[${index}] has invalid keys: ${unknownKeys.join(", ")}`,
      });
    }
    const fields: Record<string, string> = {};
    for (const field of RULE_FIELDS) {
      const coerced = coerceRuleField(record[field]);
      // A non-coercible field type (nested table/array/datetime) aborts too.
      if (coerced === undefined) {
        return yield* new LegacyDbConfigLoadError({
          message: `failed to load config: experimental.inspect.rules[${index}].${field} expected a string`,
        });
      }
      fields[field] = yield* expandField(coerced);
    }
    rules.push({
      query: fields["query"]!,
      name: fields["name"]!,
      pass: fields["pass"]!,
      fail: fields["fail"]!,
    });
  }
  return rules as ReadonlyArray<LegacyInspectRule>;
});
