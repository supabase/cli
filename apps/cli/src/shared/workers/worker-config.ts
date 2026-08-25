import { dirname } from "node:path";
import { Data, Effect, FileSystem } from "effect";
import * as SmolToml from "smol-toml";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";
import { appendTomlSection, tomlKey } from "./toml-section.ts";

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
  readonly instances?: number;
  readonly source?: string;
}

export interface WorkersSection {
  /** `[workers.<name>]` tables, keyed by worker name, in file order. */
  readonly workers: Readonly<Record<string, WorkerEntry>>;
}

/**
 * The worker is already recorded in `config.toml`.
 *
 * `workers new` creates a worker; changing one that exists is a different
 * operation, and the file is the user's to edit. Refusing is also what keeps
 * writes here append-only — amending an entry in place is what required knowing
 * enough TOML to find and rewrite it safely.
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
 * Appending the new table would leave `config.toml` unparseable.
 *
 * `appendTomlSection` renders one table and puts it at the end, which is only
 * valid when the existing file is valid TOML that does not already seal the
 * `workers` key. A config whose `[workers]` is an inline table (`workers = {}`)
 * is the case in point: TOML inline tables cannot be extended, so appending
 * `[workers.api]` produces a file nothing can read.
 *
 * Rather than enumerate the representations that break, the plan is parsed
 * before it is returned. Anything that does not round-trip is refused while the
 * refusal is still free — `new` calls this before it writes the scaffold.
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
  // Null-prototype, so a worker legitimately named `constructor`, `toString` or
  // `hasOwnProperty` reads as absent when it is absent. A plain `{}` answers
  // every one of those lookups with something inherited from
  // `Object.prototype`, which is enough to make `workers new constructor` write
  // its starter files and then refuse to record them.
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
 * Render `config.toml` with `[workers.<name>]` appended, without writing it.
 *
 * Split from the write so callers can find out an entry already exists before
 * they scaffold anything: `new` writes the starter files first, and a failure
 * after that would leave a directory nothing records.
 */
export const planWorkerEntry = Effect.fnUntraced(function* (options: {
  readonly configPath: string;
  readonly name: string;
  readonly patch: Readonly<Record<string, string>>;
  /** The already-parsed config — the authority on whether an entry exists. */
  readonly existingWorkers: Readonly<Record<string, WorkerEntry>>;
}) {
  const fs = yield* FileSystem.FileSystem;

  // Append-only, so an entry that is already there cannot be amended. The
  // decoded config is the authority on whether one exists — a question the
  // parser has answered, and one no amount of regex over the file text answers
  // reliably for a dotted or inline entry.
  if (options.existingWorkers[options.name] !== undefined) {
    return yield* Effect.fail(
      new WorkerAlreadyConfiguredError({
        detail: `"${options.name}" is already configured in ${options.configPath}.`,
        suggestion: `Edit [workers.${options.name}] in ${options.configPath} yourself, or pick a different worker name.`,
      }),
    );
  }

  const exists = yield* fs.exists(options.configPath);
  const text = exists ? yield* fs.readFileString(options.configPath) : "";
  const header = `workers.${tomlKey(options.name)}`;
  const next = appendTomlSection(text, header, options.patch);

  // The rendered file has to parse, and the new table has to be readable back
  // out of it. Appending text is a syntactic operation on a file this code did
  // not write, so the only honest check is to read the result.
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
