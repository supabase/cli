import { Data, Effect, FileSystem } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";
import { sectionExists, tomlKey, upsertTomlSection } from "./toml-section.ts";

/**
 * The `[workers]` section of `supabase/config.toml`, read through the decoded
 * project config and written back surgically.
 *
 * `[workers]` carries a project-wide `root` plus one `[workers.<name>]` table
 * per worker. The schema in `@supabase/config` models exactly that, so reading
 * is a matter of splitting the scalar off the record; writing goes through
 * `./toml-section.ts` so a user's comments and formatting survive.
 */

/** One worker's recorded metadata. Every key is optional. */
export interface WorkerEntry {
  readonly runtime?: string;
  readonly size?: string;
  readonly source?: string;
}

export interface WorkersSection {
  /** `[workers] root`, unvalidated — see `resolveWorkersRoot`. */
  readonly root: string | undefined;
  /** `[workers.<name>]` tables, keyed by worker name, in file order. */
  readonly workers: Readonly<Record<string, WorkerEntry>>;
}

/**
 * A worker is present in the config but not as its own `[workers.<name>]` table
 * — an inline `workers = { … }`, or dotted `workers.<name>.runtime = …` keys.
 * Appending a table would duplicate the key and leave the file invalid, and
 * rewriting the whole file would cost the user every comment in it, so this
 * asks for the one edit that makes a surgical write possible.
 */
export class WorkerEntryNotATableError extends Data.TaggedError("WorkerEntryNotATableError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * A key the CLI wants to set is written across several lines (an array, an
 * inline table, a `"""` string). Swapping one line would strand its
 * continuation and leave the file unparseable, so the edit stops instead.
 */
export class WorkerEntryValueNotEditableError extends Data.TaggedError(
  "WorkerEntryValueNotEditableError",
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
 * Split the decoded `[workers]` section into its project-wide `root` and its
 * per-worker tables. A scalar written directly under `[workers]` parses as a
 * sibling of the sub-tables, so anything that is not an object is dropped here
 * rather than read as a worker named after it.
 */
export function readWorkersSection(workers: unknown): WorkersSection {
  if (typeof workers !== "object" || workers === null || Array.isArray(workers)) {
    return { root: undefined, workers: {} };
  }

  const entries: Record<string, WorkerEntry> = {};
  for (const [key, value] of Object.entries(workers)) {
    if (key === "root" || typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    entries[key] = {
      runtime: stringOrUndefined(entry["runtime"]),
      size: stringOrUndefined(entry["size"]),
      source: stringOrUndefined(entry["source"]),
    };
  }

  // `root` is passed through as written (empty string included) so an obviously
  // wrong value reaches `resolveWorkersRoot` and gets named, rather than
  // silently falling back to the default.
  const root = (workers as Record<string, unknown>)["root"];
  return {
    root: typeof root === "string" ? root : undefined,
    workers: entries,
  };
}

/**
 * Set `patch`'s keys on `[workers.<name>]` in `configPath`, leaving every other
 * byte of the file untouched. Creates the file (and its `supabase/` directory)
 * when it does not exist yet, so `new` works in a directory that has never been
 * `supabase init`-ed.
 */
export const writeWorkerEntry = Effect.fnUntraced(function* (options: {
  readonly configPath: string;
  readonly name: string;
  readonly patch: Readonly<Record<string, string>>;
  /** The already-parsed config, used only to detect a non-table entry. */
  readonly existingWorkers: Readonly<Record<string, WorkerEntry>>;
}) {
  const fs = yield* FileSystem.FileSystem;

  const exists = yield* fs.exists(options.configPath);
  const text = exists ? yield* fs.readFileString(options.configPath) : "";
  const header = `workers.${tomlKey(options.name)}`;

  if (options.existingWorkers[options.name] !== undefined && !sectionExists(text, header)) {
    return yield* Effect.fail(
      new WorkerEntryNotATableError({
        detail: `"${options.name}" is configured in ${options.configPath} but not as a standalone [${header}] table.`,
        suggestion: `Move it into its own [${header}] table so the CLI can update it without rewriting the file.`,
      }),
    );
  }

  const edit = upsertTomlSection(text, header, options.patch);
  if (edit._tag === "Unsupported") {
    return yield* Effect.fail(
      new WorkerEntryValueNotEditableError({
        detail: `[${header}] ${edit.key} in ${options.configPath} spans multiple lines, so the CLI cannot rewrite it safely.`,
        suggestion: `Put ${edit.key} on a single line, or remove it and let the CLI write it.`,
      }),
    );
  }

  yield* fs.writeFileString(options.configPath, edit.text);
});
