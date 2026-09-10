import { dirname } from "node:path";
import { Data, Effect, FileSystem } from "effect";
import * as SmolToml from "smol-toml";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";
import { appendTomlSection, isRenderableTomlNumber, tomlKey } from "./toml-section.ts";

/**
 * The `[workers]` section of `supabase/config.toml`, read through the decoded
 * project config and written back surgically.
 *
 * `[workers]` carries one `[workers.<name>]` table per worker. The schema in
 * `@supabase/config` models exactly that; writing goes through
 * `./toml-section.ts` so a user's comments and formatting survive.
 */

/** One worker's recorded metadata. Every key is optional. */
export interface WorkerEntry {
  readonly runtime?: string;
  readonly size?: string;
  readonly exposure?: string;
  readonly instances?: number;
  readonly source?: string;
}

export interface WorkersSection {
  /** `[workers.<name>]` tables, keyed by worker name, in file order. */
  readonly workers: Readonly<Record<string, WorkerEntry>>;
}

/**
 * The worker is already recorded in `config.toml`. `workers new` creates a worker; changing
 * one that exists is a different operation, and the file is the user's to edit. Refusing also
 * keeps writes append-only, avoiding the need to find and rewrite an entry in place.
 */
export class WorkerAlreadyConfiguredError extends Data.TaggedError("WorkerAlreadyConfiguredError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Appending the new table would leave `config.toml` unparseable — e.g. a `[workers]` that's
 * already an inline table (`workers = {}`) can't be extended, so appending `[workers.api]`
 * produces a file nothing can read. Rather than enumerate every representation that breaks,
 * the plan is parsed before it's returned and anything that doesn't round-trip is refused,
 * before `new` writes the scaffold.
 */
export class WorkerConfigWriteUnsafeError extends Data.TaggedError("WorkerConfigWriteUnsafeError")<{
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

/** A plain object — a `[workers.<name>]` table rather than a scalar or a list. */
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
 * The decoded `[workers]` section as per-worker tables. Anything that is not an
 * object is dropped rather than read as a worker named after it.
 */
export function readWorkersSection(workers: unknown): WorkersSection {
  // Null-prototype, so a worker named `constructor`, `toString`, or `hasOwnProperty` reads as
  // absent when it is: a plain `{}` would answer those lookups from `Object.prototype`,
  // enough to make `workers new constructor` write its starter files and refuse to record them.
  const entries: Record<string, WorkerEntry> = Object.create(null);

  if (!isRecord(workers)) {
    return { workers: entries };
  }

  for (const [key, value] of Object.entries(workers)) {
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
    };
  }

  return { workers: entries };
}

/** A rendered `config.toml`, not yet written. */
export interface WorkerEntryWrite {
  readonly configPath: string;
  readonly text: string;
}

/**
 * Renders `config.toml` with `[workers.<name>]` appended, without writing it. Split from the
 * write so callers can find out an entry already exists before they scaffold anything: `new`
 * writes the starter files first, and a failure after that would leave a directory nothing
 * records.
 */
export const planWorkerEntry = Effect.fnUntraced(function* (options: {
  readonly configPath: string;
  readonly name: string;
  /** Rendered as written: strings are quoted, numbers are not. */
  readonly patch: Readonly<Record<string, string | number>>;
  /** The already-parsed config — the authority on whether an entry exists. */
  readonly existingWorkers: Readonly<Record<string, WorkerEntry>>;
}) {
  const fs = yield* FileSystem.FileSystem;

  // Append-only, so an entry that already exists cannot be amended. The decoded config is
  // the authority on whether one exists — regex over the file text can't answer that
  // reliably for a dotted or inline entry.
  if (options.existingWorkers[options.name] !== undefined) {
    return yield* Effect.fail(
      new WorkerAlreadyConfiguredError({
        detail: `"${options.name}" is already configured in ${options.configPath}.`,
        suggestion: `Edit [workers.${options.name}] in ${options.configPath} yourself, or pick a different worker name.`,
      }),
    );
  }

  // Before rendering, since the re-parse below is a syntax check only: `1.5` or `-1` render
  // as valid TOML that only the schema rejects, so they'd sail through and land in the
  // user's config as a `[workers]` section the loader then refuses.
  const unrenderable = Object.entries(options.patch).find(
    ([, value]) => typeof value === "number" && !isRenderableTomlNumber(value),
  );
  if (unrenderable !== undefined) {
    return yield* Effect.fail(
      new WorkerConfigWriteUnsafeError({
        detail: `Recording "${options.name}" would write ${unrenderable[0]} = ${String(unrenderable[1])} to ${options.configPath}, which is not a whole, non-negative count.`,
        suggestion: `Pass a whole number of zero or more, or add [workers.${options.name}] to ${options.configPath} yourself.`,
      }),
    );
  }

  const exists = yield* fs.exists(options.configPath);
  const text = exists ? yield* fs.readFileString(options.configPath) : "";
  const header = `workers.${tomlKey(options.name)}`;
  const next = appendTomlSection(text, header, options.patch);

  // The rendered file has to parse and the new table has to be readable back out of it —
  // appending is a syntactic operation on a file this code didn't write, so reading the
  // result back is the only honest check.
  const parsed = yield* Effect.try({
    try: () => SmolToml.parse(next),
    catch: (cause) =>
      new WorkerConfigWriteUnsafeError({
        detail: `Recording "${options.name}" would make ${options.configPath} unparseable: ${String(cause)}.`,
        suggestion: `Add [workers.${options.name}] to ${options.configPath} yourself.`,
      }),
  });

  const workers = parsed["workers"];
  if (
    typeof workers !== "object" ||
    workers === null ||
    Array.isArray(workers) ||
    !(options.name in workers)
  ) {
    return yield* Effect.fail(
      new WorkerConfigWriteUnsafeError({
        detail: `Recording "${options.name}" in ${options.configPath} would not take effect, because its [workers] section cannot be extended by appending a table.`,
        suggestion: `Add [workers.${options.name}] to ${options.configPath} yourself.`,
      }),
    );
  }

  return {
    configPath: options.configPath,
    text: next,
  } satisfies WorkerEntryWrite;
});

/**
 * Commit a {@link planWorkerEntry} result. Creates `supabase/` if it does not
 * exist yet, so `new` works in a directory that has never been `supabase
 * init`-ed.
 */
export const commitWorkerEntry = Effect.fnUntraced(function* (write: WorkerEntryWrite) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(write.configPath), { recursive: true });
  yield* fs.writeFileString(write.configPath, write.text);
});
