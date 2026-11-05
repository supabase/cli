import { Data, Effect, FileSystem, Path } from "effect";
import {
  applyConfigEdits,
  cliConfigFormatForPath,
  parseCliConfigDocument,
} from "@supabase/config/internal";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";
import {
  appendTomlSection,
  isRenderableTomlNumber,
  tomlKey,
  type TomlSectionValue,
} from "./toml-section.ts";

/**
 * The `[compute]` section of the project config, read through the decoded
 * project config and written back surgically.
 *
 * `[compute]` carries one `[compute.<name>]` table per compute. The schema in
 * `@supabase/config` models exactly that; TOML writes go through
 * `./toml-section.ts` and JSON/JSONC writes through `applyConfigEdits`, so a
 * user's comments and formatting survive.
 */

/** One compute's recorded metadata. Every key is optional. */
export interface ComputeEntry {
  readonly runtime?: string;
  readonly size?: string;
  readonly exposure?: string;
  readonly instances?: number;
  readonly source?: string;
  readonly exclude?: ReadonlyArray<string>;
}

export interface ComputeSection {
  /** `[compute.<name>]` tables, keyed by compute name, in file order. */
  readonly compute: Readonly<Record<string, ComputeEntry>>;
}

/**
 * The compute is already recorded in the project config. `compute new` creates a compute; changing
 * one that exists is a different operation, and the file is the user's to edit. Refusing also
 * keeps writes append-only, avoiding the need to find and rewrite an entry in place.
 */
export class ComputeAlreadyConfiguredError extends Data.TaggedError(
  "ComputeAlreadyConfiguredError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Appending the new table would leave the config unparseable — e.g. a `[compute]` that's
 * already an inline table (`compute = {}`) can't be extended, so appending `[compute.api]`
 * produces a file nothing can read. Rather than enumerate every representation that breaks,
 * the plan is parsed before it's returned and anything that doesn't round-trip is refused,
 * before `new` writes the scaffold.
 */
export class ComputeConfigWriteUnsafeError extends Data.TaggedError(
  "ComputeConfigWriteUnsafeError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * As {@link stringOrUndefined}, but an explicitly empty string survives. For `exposure`,
 * "recorded but unusable" must not read as "not recorded": absent means the `public` default,
 * so folding `exposure = ""` into `undefined` would silently widen a config that plainly
 * tried to say something to the most open setting there is. `runtime`, `size`, and `source`
 * keep the collapsing reader, since their fallbacks (a marker-file guess, a default size, the
 * conventional directory) don't widen anything.
 */
const recordedStringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A plain object — a `[compute.<name>]` table rather than a scalar or a list. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A count only counts if it is a non-negative whole number. Anything else is
 * dropped so `push` falls back to its own default; the config schema is what
 * tells the user the value was wrong.
 */
const instanceCountOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * The recorded exclude patterns, or `undefined` when the key is absent or holds something
 * other than a list. Entries are left exactly as written, blanks included: `push` compiles
 * them and names the one it cannot read, and a pattern dropped here would upload the file it
 * was written to withhold.
 */
const patternsOrUndefined = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const patterns = value.filter((entry): entry is string => typeof entry === "string");
  return patterns.length === value.length ? patterns : undefined;
};

/**
 * The decoded `[compute]` section as per-compute tables. Anything that is not an
 * object is dropped rather than read as a compute named after it.
 */
export function readComputeSection(compute: unknown): ComputeSection {
  // Null-prototype, so a compute legitimately named `constructor`, `toString` or
  // `hasOwnProperty` reads as absent when it is absent. A plain `{}` answers
  // every one of those lookups with something inherited from
  // `Object.prototype`, which is enough to make `compute new constructor` write
  // its starter files and then refuse to record them.
  const entries: Record<string, ComputeEntry> = Object.create(null);

  if (!isRecord(compute)) {
    return { compute: entries };
  }

  for (const [key, value] of Object.entries(compute)) {
    if (!isRecord(value)) {
      continue;
    }
    entries[key] = {
      runtime: stringOrUndefined(value["runtime"]),
      size: stringOrUndefined(value["size"]),
      // Left as written, empty included: `push` names the accepted values, and dropping an
      // unrecognized one here would silently deploy at the default exposure instead.
      exposure: recordedStringOrUndefined(value["exposure"]),
      instances: instanceCountOrUndefined(value["instances"]),
      source: stringOrUndefined(value["source"]),
      exclude: patternsOrUndefined(value["exclude"]),
    };
  }

  return { compute: entries };
}

/** A rendered project config, not yet written. */
export interface ComputeEntryWrite {
  readonly configPath: string;
  readonly text: string;
}

/**
 * Renders the project config with the compute entry added, without writing it. Split from the
 * write so callers can find out an entry already exists before they scaffold anything: `new`
 * writes the starter files first, and a failure after that would leave a directory nothing
 * records.
 */
export const planComputeEntry = Effect.fn("Compute.planConfigEntry")(function* (options: {
  readonly configPath: string;
  readonly name: string;
  /** Rendered as written: strings are quoted, numbers are not, lists become arrays. */
  readonly patch: Readonly<Record<string, TomlSectionValue>>;
  /** The already-parsed config — the authority on whether an entry exists. */
  readonly existingCompute: Readonly<Record<string, ComputeEntry>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const format = cliConfigFormatForPath(options.configPath);
  const entryRef = format === "toml" ? `[compute.${options.name}]` : `compute.${options.name}`;

  // Append-only, so an entry that already exists cannot be amended. The decoded config is
  // the authority on whether one exists — regex over the file text can't answer that
  // reliably for a dotted or inline entry.
  if (options.existingCompute[options.name] !== undefined) {
    return yield* new ComputeAlreadyConfiguredError({
      detail: `"${options.name}" is already configured in ${options.configPath}.`,
      suggestion: `Edit ${entryRef} in ${options.configPath} yourself, or pick a different compute name.`,
    });
  }

  // Before rendering, since the re-parse below is a syntax check only: `1.5` or `-1` render
  // as valid TOML that only the schema rejects, so they'd sail through and land in the
  // user's config as a `[compute]` section the loader then refuses.
  const unrenderable = Object.entries(options.patch).find(
    ([, value]) => typeof value === "number" && !isRenderableTomlNumber(value),
  );
  if (unrenderable !== undefined) {
    return yield* new ComputeConfigWriteUnsafeError({
      detail: `Recording "${options.name}" would write ${unrenderable[0]} = ${String(unrenderable[1])} to ${options.configPath}, which is not a whole, non-negative count.`,
      suggestion: `Pass a whole number of zero or more, or add ${entryRef} to ${options.configPath} yourself.`,
    });
  }

  const exists = yield* fs.exists(options.configPath);
  const text = exists ? yield* fs.readFileString(options.configPath) : "";
  let next: string;
  if (format === "toml") {
    next = appendTomlSection(text, `compute.${tomlKey(options.name)}`, options.patch);
  } else {
    const outcome = applyConfigEdits(text, format, [
      { path: ["compute", options.name], value: options.patch },
    ]);
    if (outcome.kind === "refused") {
      return yield* new ComputeConfigWriteUnsafeError({
        detail: `Recording "${options.name}" in ${options.configPath} was refused: ${outcome.refusal.detail}`,
        suggestion: `Add ${entryRef} to ${options.configPath} yourself.`,
      });
    }
    next = outcome.text;
  }

  // The rendered file has to parse and the new entry has to be readable back out of it —
  // editing is a syntactic operation on a file this code didn't write, so reading the
  // result back is the only honest check.
  const parsed = yield* Effect.try({
    try: () => parseCliConfigDocument(next, format),
    catch: (cause) =>
      new ComputeConfigWriteUnsafeError({
        detail: `Recording "${options.name}" would make ${options.configPath} unparseable: ${String(cause)}.`,
        suggestion: `Add ${entryRef} to ${options.configPath} yourself.`,
      }),
  });

  const compute = isRecord(parsed) ? parsed["compute"] : undefined;
  if (!isRecord(compute) || !(options.name in compute)) {
    return yield* new ComputeConfigWriteUnsafeError({
      detail:
        format === "toml"
          ? `Recording "${options.name}" in ${options.configPath} would not take effect, because its [compute] section cannot be extended by appending a table.`
          : `Recording "${options.name}" in ${options.configPath} would not take effect, because its compute section cannot hold the new entry.`,
      suggestion: `Add ${entryRef} to ${options.configPath} yourself.`,
    });
  }

  return {
    configPath: options.configPath,
    text: next,
  } satisfies ComputeEntryWrite;
});

/**
 * Commit a {@link planComputeEntry} result. Creates `supabase/` if it does not
 * exist yet, so `new` works in a directory that has never been `supabase
 * init`-ed.
 */
export const commitComputeEntry = Effect.fn("Compute.commitConfigEntry")(function* (
  write: ComputeEntryWrite,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(write.configPath), { recursive: true });
  yield* fs.writeFileString(write.configPath, write.text);
});
