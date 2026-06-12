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

/**
 * Coerce a rule field value to a string, mirroring Go's mapstructure decoder under
 * viper's default `WeaklyTypedInput: true` (Go's `config.Load` calls
 * `v.UnmarshalExact` without disabling it — `apps/cli-go/pkg/config/config.go:579-584`):
 * a string passes through; a number/bigint becomes its decimal string; a boolean
 * becomes `"1"`/`"0"`; a missing field is the zero value `""`. Any other type (a
 * nested table/array/datetime as a scalar field) is NOT coercible — mapstructure's
 * `decodeString` falls through to "expected type 'string'" and Go aborts — so this
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
  for (let index = 0; index < rawRules.length; index++) {
    const record = asRecord(rawRules[index]);
    // A non-table array entry (e.g. `rules = ["foo"]`) is rejected by Go: mapstructure
    // routes the element into `decodeStruct`, whose default branch returns "expected a
    // map or struct", aborting `config.Load`. Match that rather than silently skipping.
    if (record === undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `failed to load config: experimental.inspect.rules[${index}] expected a map or struct`,
        }),
      );
    }
    const fields: Record<string, string> = {};
    for (const field of ["query", "name", "pass", "fail"] as const) {
      const coerced = coerceRuleField(record[field]);
      // A non-coercible field type (nested table/array/datetime) aborts in Go too.
      if (coerced === undefined) {
        return yield* Effect.fail(
          new LegacyDbConfigLoadError({
            message: `failed to load config: experimental.inspect.rules[${index}].${field} expected a string`,
          }),
        );
      }
      fields[field] = legacyExpandEnv(coerced, lookup);
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
