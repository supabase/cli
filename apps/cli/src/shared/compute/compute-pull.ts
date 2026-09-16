import {
  applyConfigEdits,
  ENV_CAPTURE_REGEX,
  writeCliConfigDocumentText,
  type ConfigEdit,
  type ConfigEditRefusalReason,
} from "@supabase/config/internal";
import type { ConfigFormat } from "@supabase/config";
import { gunzipSync } from "node:zlib";
import { Effect, FileSystem, Option, Path } from "effect";

import type { ComputeRecord } from "./compute-api.ts";
import {
  ComputeConfigPullUnsupportedLayoutError,
  ComputeConfigPullWriteError,
  ComputeSourceUnpackError,
} from "./compute.errors.ts";
import { computeDir, computeSourceDir } from "./compute-paths.ts";
import { validateComputeNameMessage } from "./compute-runtimes.ts";
import { readTar } from "./tar.ts";

/**
 * Reconciles `[compute.<name>]` against the computes a project actually has deployed.
 *
 * Only metadata travels: `/v2/projects/{ref}/compute` has no route that returns a build
 * context, so a compute's code can never be recovered from the platform. The plan names which
 * deployed computes have no local source so the gap is at least reported.
 */

/** The `[compute.<name>]` keys this reconciliation owns. `source` is absent on purpose: it is a
 *  local path the platform knows nothing about. */
type ComputePullKey = "runtime" | "size" | "exposure" | "instances";

const COMPUTE_PULL_KEYS: ReadonlyArray<ComputePullKey> = [
  "runtime",
  "size",
  "exposure",
  "instances",
];

/** One key of one compute that differs between the deployed spec and what the config declares. */
interface ComputePullChange {
  readonly name: string;
  readonly key: ComputePullKey;
  /** The declared local literal, or `undefined` when the config does not mention this key. */
  readonly local: string | number | undefined;
  readonly remote: string | number;
}

type ComputePullSkipReason = "env_reference" | "unrepresentable";

interface ComputePullSkip {
  readonly name: string;
  readonly key: ComputePullKey;
  readonly reason: ComputePullSkipReason;
}

export interface ComputePullPlan {
  /** Every deployed compute the API reported, sorted. */
  readonly deployed: ReadonlyArray<string>;
  readonly changes: ReadonlyArray<ComputePullChange>;
  readonly skipped: ReadonlyArray<ComputePullSkip>;
  /** Names the config declares with no deployed counterpart. Never written to or removed. */
  readonly localOnly: ReadonlyArray<string>;
  readonly hasWork: boolean;
}

/** The deployed spec as `[compute.<name>]` would spell it. */
export interface ComputePullDesiredEntry {
  readonly runtime: string;
  readonly size: string;
  readonly exposure: string | undefined;
  readonly instances: number | undefined;
}

const API_SIZE_PATTERN = /^(\d+gb)-(\d+)vcpu$/;

/**
 * The API's `spec.size` (`2gb-1vcpu`) as `[compute.<name>] size` spells it (`2gb`) — each size
 * implies its own vCPU count, so the config carries the memory alone. A spelling this pattern
 * does not recognize is recorded verbatim rather than guessed at: `push` refuses an unknown size
 * by name and points at the catalog, which beats silently dropping the key and deploying at the
 * default.
 */
export function computeSizeForConfig(apiSize: string): string {
  const match = API_SIZE_PATTERN.exec(apiSize.trim().toLowerCase());
  return match?.[1] ?? apiSize;
}

/**
 * What the config should say about a deployed compute. The API omits `spec.runtime` only for a
 * context-only build, so its absence means `dockerfile` — the same reading `compute list` uses.
 */
export function computePullDesiredEntry(record: ComputeRecord): ComputePullDesiredEntry {
  return {
    runtime: record.spec.runtime ?? "dockerfile",
    size: computeSizeForConfig(record.spec.size),
    exposure: record.spec.exposure,
    // An out-of-range count cannot be recorded: the config schema bounds `instances` to a whole
    // number of zero or more, and writing anything else would make the file unloadable.
    instances:
      Number.isInteger(record.spec.instances) && record.spec.instances >= 0
        ? record.spec.instances
        : undefined,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `[compute]` table inside `document`, or an empty view when it is absent or not a table. */
function computeTableOf(document: unknown): Readonly<Record<string, unknown>> {
  const compute = isRecord(document) ? document["compute"] : undefined;
  return isRecord(compute) ? compute : {};
}

/**
 * The declared literal at `[compute.<name>] <key>`, reading the effective value a
 * `[remotes.<label>]` block would produce: the block's own spelling when it declares the key,
 * the config root's otherwise. Both operands come from the raw, pre-`env()` document, so an
 * `env(VAR)` reference arrives as its literal spelling and can be refused rather than erased.
 */
function declaredValue(
  rootCompute: Readonly<Record<string, unknown>>,
  blockCompute: Readonly<Record<string, unknown>>,
  name: string,
  key: ComputePullKey,
): unknown {
  const fromBlock = isRecord(blockCompute[name]) ? blockCompute[name][key] : undefined;
  if (fromBlock !== undefined) {
    return fromBlock;
  }
  return isRecord(rootCompute[name]) ? rootCompute[name][key] : undefined;
}

function isEnvReference(value: unknown): boolean {
  return typeof value === "string" && ENV_CAPTURE_REGEX.test(value);
}

/**
 * A declared value that already agrees with the deployed spec. Compared after coercing the
 * declared value to the remote's own type, so `instances = "2"` still reads as drift rather
 * than a match a string comparison would accept.
 */
function matchesRemote(local: unknown, remote: string | number): boolean {
  return typeof remote === "number" ? local === remote : local === remote;
}

export interface PlanComputePullInput {
  /** Every compute the API reports as deployed. */
  readonly deployed: ReadonlyArray<ComputeRecord>;
  /** The raw, pre-`env()` config root — `LoadedCliConfig.rawDocument`. */
  readonly rootDocument: unknown;
  /**
   * The raw `[remotes.<label>]` block the writes target, when the destination is a remote block;
   * `undefined` for a root destination or a block this pull creates from scratch.
   */
  readonly blockDocument: unknown;
}

/**
 * Which `[compute.<name>]` keys this pull would write. Pure: no filesystem, no network.
 *
 * A deployed compute whose name is not a DNS label is dropped — it could never be recorded as
 * `[compute.<name>]`, and the config schema would reject the key.
 */
export function planComputePull(input: PlanComputePullInput): ComputePullPlan {
  const rootCompute = computeTableOf(input.rootDocument);
  const blockCompute = computeTableOf(input.blockDocument);

  const deployed = input.deployed
    .filter((record) => validateComputeNameMessage(record.name) === undefined)
    .map((record) => record.name)
    .sort();

  const changes: Array<ComputePullChange> = [];
  const skipped: Array<ComputePullSkip> = [];

  for (const record of input.deployed) {
    if (validateComputeNameMessage(record.name) !== undefined) {
      continue;
    }
    const desired = computePullDesiredEntry(record);
    for (const key of COMPUTE_PULL_KEYS) {
      const remote = desired[key];
      if (remote === undefined) {
        skipped.push({ name: record.name, key, reason: "unrepresentable" });
        continue;
      }
      const local = declaredValue(rootCompute, blockCompute, record.name, key);
      if (isEnvReference(local)) {
        // Writing here would erase the user's indirection, and `applyConfigEdits` refuses an
        // `env()` destination anyway.
        skipped.push({ name: record.name, key, reason: "env_reference" });
        continue;
      }
      if (matchesRemote(local, remote)) {
        continue;
      }
      changes.push({
        name: record.name,
        key,
        local: typeof local === "string" || typeof local === "number" ? local : undefined,
        remote,
      });
    }
  }

  const deployedNames = new Set(deployed);
  const localOnly = [...new Set([...Object.keys(rootCompute), ...Object.keys(blockCompute)])]
    .filter((name) => !deployedNames.has(name))
    .sort();

  return { deployed, changes, skipped, localOnly, hasWork: changes.length > 0 };
}

/**
 * Deployed computes whose source directory holds nothing in this checkout — the part of the
 * gap a pull cannot close, since the platform exposes no build-context download. An unusable
 * `source` (one escaping the project, say) reads the same as no local source: the compute still
 * has nowhere here to push from.
 */
export const computePullMissingSource = Effect.fnUntraced(function* (input: {
  readonly projectRoot: string;
  readonly names: ReadonlyArray<string>;
  readonly configuredSource: (name: string) => string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const missing: Array<string> = [];

  for (const name of input.names) {
    const sourceDir = yield* computeSourceDir({
      projectRoot: input.projectRoot,
      defaultDir: computeDir(path, input.projectRoot, name),
      name,
      configuredSource: input.configuredSource(name),
    }).pipe(Effect.option);
    if (Option.isNone(sourceDir)) {
      missing.push(name);
      continue;
    }
    const info = yield* fs.stat(sourceDir.value).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") {
      missing.push(name);
    }
  }

  return missing;
});

/** Human-readable phrase for a refusal reason, so the raw enum token never reaches a message. */
function refusalPhrase(reason: ConfigEditRefusalReason): string {
  switch (reason) {
    case "duplicate_table_header":
      return "a duplicate table header";
    case "array_of_tables_on_path":
      return "an array of tables on this path";
    case "inline_table_on_path":
      return "an inline table on this path";
    case "env_reference_target":
      return "an existing env() reference at this path";
    case "verification_mismatch":
      return "a verification mismatch after editing";
    case "parse_error":
      return "a parse error";
  }
}

function refusalRemediation(reason: ConfigEditRefusalReason): string {
  switch (reason) {
    case "duplicate_table_header":
      return "Merge the duplicate table headers into one, then rerun.";
    case "inline_table_on_path":
      return "Rewrite it as a standard [table] section, then rerun.";
    case "array_of_tables_on_path":
      return "Restructure it by hand, then rerun.";
    case "env_reference_target":
      return "Replace the env(...) reference with a literal value, then rerun.";
    case "verification_mismatch":
    case "parse_error":
      return "This is a CLI bug; nothing was written. Please report it.";
  }
}

/**
 * Applies a {@link planComputePull} result to the config file.
 *
 * Reads the file fresh rather than editing a text baseline captured at plan time: `supabase
 * pull` plans this step before its confirmation but applies it after the config step has
 * already rewritten the same file. That is safe to edit over because the config step can never
 * touch `[compute]` — the section has no API↔config mapping rows, so it never appears in a
 * config change set — while re-reading is what keeps this step's write from clobbering it.
 */
export const applyComputePull = Effect.fnUntraced(function* (input: {
  readonly plan: ComputePullPlan;
  readonly configFilePath: string;
  /** The config file path as messages should spell it, e.g. `supabase/config.toml`. */
  readonly configPath: string;
  readonly format: ConfigFormat;
  /** `["remotes", label]` when the writes target a remote block, `[]` for the config root. */
  readonly destinationPath: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;

  const currentText = yield* fs.readFileString(input.configFilePath).pipe(
    Effect.mapError(
      (cause) =>
        new ComputeConfigPullWriteError({
          detail: `${input.configPath} could not be read: ${cause.message}`,
          suggestion: "Check the file's permissions, then rerun the command.",
        }),
    ),
  );

  const edits: ReadonlyArray<ConfigEdit> = input.plan.changes.map((change) => ({
    path: [...input.destinationPath, "compute", change.name, change.key],
    value: change.remote,
  }));

  const outcome = applyConfigEdits(currentText, input.format, edits);
  if (outcome.kind === "refused") {
    const { reason, path, detail } = outcome.refusal;
    const location = path.length === 0 ? "" : ` at ${path.join(".")}`;
    return yield* new ComputeConfigPullUnsupportedLayoutError({
      detail: `Cannot record compute in ${input.configPath}: ${refusalPhrase(reason)}${location} — ${detail}.`,
      suggestion: refusalRemediation(reason),
    });
  }

  yield* writeCliConfigDocumentText(input.configFilePath, outcome.text).pipe(
    Effect.mapError(
      (cause) =>
        new ComputeConfigPullWriteError({
          detail: cause.message,
          suggestion: "Check the file's permissions, then rerun the command.",
        }),
    ),
  );
});

/**
 * Where one archive entry may be written, or `undefined` when it must be refused.
 *
 * The archive is remote-supplied bytes, so every entry path is treated as hostile: an absolute
 * path, a `..` segment, or a drive/UNC-style prefix is rejected outright rather than normalized,
 * since normalizing is what turns `a/../../etc` into a write outside the tree. The check is on
 * the entry's own text, before it is ever joined onto the destination.
 */
function confinedEntryPath(path: Path.Path, destination: string, entryPath: string) {
  const normalized = entryPath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") {
    return undefined;
  }
  const segments = normalized.split("/");
  if (
    path.isAbsolute(normalized) ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.some((segment) => segment === ".." || segment === "")
  ) {
    return undefined;
  }
  const target = path.join(destination, ...segments);
  // Belt and braces: even with every segment vetted, the joined result has to land inside.
  const relative = path.relative(destination, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return target;
}

/**
 * A symlink's target as it may be written, or `undefined` when it escapes.
 *
 * Resolved against the link's own directory and required to stay inside `destination`, the
 * inverse of `compute-package.ts`'s `confinedLinkTarget` on the push side. A link pointing out
 * of the tree is the classic way an archive turns a later benign-looking write into a write
 * anywhere on the filesystem, so it is refused rather than dropped.
 */
function confinedLinkDestination(
  path: Path.Path,
  destination: string,
  linkPath: string,
  target: string,
): string | undefined {
  const resolved = path.resolve(path.dirname(linkPath), target);
  const relative = path.relative(destination, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return target;
}

/**
 * Unpacks a downloaded `.tar.gz` build context into `destination`.
 *
 * Overwrites what the archive names and leaves everything else in place — the same shape
 * `functions download` has, where a pull refreshes the files the remote knows about without
 * taking responsibility for deleting local ones it does not. Nothing is written until every
 * entry has been vetted, so a refusal leaves the directory exactly as it was.
 */
export const restoreComputeSource = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly destination: string;
  readonly archive: Uint8Array;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tar = yield* Effect.try({
    try: () => gunzipSync(options.archive),
    catch: (cause) =>
      new ComputeSourceUnpackError({
        detail: `The build context for "${options.name}" is not a valid gzip archive: ${String(cause)}.`,
        suggestion: "Re-run the command; if it persists, report it with `supabase issue`.",
      }),
  });

  const entries = yield* readTar(new Uint8Array(tar)).pipe(
    Effect.mapError(
      (cause) =>
        new ComputeSourceUnpackError({
          detail: `The build context for "${options.name}" could not be read: ${cause.detail}.`,
          suggestion: "Re-run the command; if it persists, report it with `supabase issue`.",
        }),
    ),
  );

  // Vetted in full before the first write: a half-unpacked tree is worse than an untouched one,
  // and the refusal below is the whole point of reading a remote archive.
  const planned: Array<{
    readonly target: string;
    readonly entry: (typeof entries)[number];
    readonly linkTarget: string | undefined;
  }> = [];
  for (const entry of entries) {
    const target = confinedEntryPath(path, options.destination, entry.path);
    if (target === undefined) {
      return yield* new ComputeSourceUnpackError({
        detail: `The build context for "${options.name}" contains an entry that would be written outside its source directory.`,
        suggestion:
          "This archive is not safe to unpack; nothing was written. Report it with `supabase issue`.",
      });
    }
    if (entry.linkTarget === undefined) {
      planned.push({ target, entry, linkTarget: undefined });
      continue;
    }
    const linkTarget = confinedLinkDestination(path, options.destination, target, entry.linkTarget);
    if (linkTarget === undefined) {
      return yield* new ComputeSourceUnpackError({
        detail: `The build context for "${options.name}" contains a symbolic link pointing outside its source directory.`,
        suggestion:
          "This archive is not safe to unpack; nothing was written. Report it with `supabase issue`.",
      });
    }
    planned.push({ target, entry, linkTarget });
  }

  yield* fs.makeDirectory(options.destination, { recursive: true });

  const written: Array<string> = [];
  for (const item of planned) {
    if (item.linkTarget !== undefined) {
      yield* fs.makeDirectory(path.dirname(item.target), { recursive: true });
      // Replaced rather than written through: an existing symlink at this path would otherwise
      // redirect the write, and an existing file would make the link fail.
      yield* fs.remove(item.target, { recursive: true }).pipe(Effect.ignore);
      yield* fs.symlink(item.linkTarget, item.target);
      written.push(item.target);
      continue;
    }
    if (item.entry.path.endsWith("/")) {
      yield* fs.makeDirectory(item.target, { recursive: true });
      continue;
    }
    yield* fs.makeDirectory(path.dirname(item.target), { recursive: true });
    // Removed first for the same reason a symlink is: a link left by an earlier archive (or by
    // the user) must not turn this write into a write somewhere else.
    yield* fs.remove(item.target, { recursive: true }).pipe(Effect.ignore);
    yield* fs.writeFile(item.target, item.entry.contents);
    if (item.entry.mode !== undefined && item.entry.mode !== 0) {
      // Only the permission bits; the archive's uid/gid are never applied.
      yield* fs.chmod(item.target, item.entry.mode & 0o777).pipe(Effect.ignore);
    }
    written.push(item.target);
  }

  return written.length;
});
