import { Effect, FileSystem } from "effect";
import * as SmolToml from "smol-toml";
import { loadProjectConfig, writeFileAtomic } from "./io.ts";
import {
  RemoteBlockNotRemovableError,
  RemoteNameConflictError,
  RemoteNameInvalidError,
  RemoteNotFoundError,
  RemoteRefInvalidError,
} from "./errors.ts";
import { findProjectPaths } from "./paths.ts";

/** TOML bare-key subset — no quoting, no dotted-key ambiguity. */
export const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Same 20-lowercase-letter shape Go's `Config.Validate` checks (`REMOTE_PROJECT_ID_PATTERN`, `io.ts`). */
export const REMOTE_PROJECT_REF_PATTERN = /^[a-z]{20}$/;

export interface RemoteEntry {
  readonly name: string;
  readonly projectRef: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRemoteName(name: string): Effect.Effect<void, RemoteNameInvalidError> {
  if (REMOTE_NAME_PATTERN.test(name)) return Effect.void;
  return Effect.fail(
    new RemoteNameInvalidError({
      name,
      message: `Invalid remote name "${name}". Must match ${REMOTE_NAME_PATTERN.source}.`,
    }),
  );
}

export function validateRemoteRef(ref: string): Effect.Effect<void, RemoteRefInvalidError> {
  if (REMOTE_PROJECT_REF_PATTERN.test(ref)) return Effect.void;
  return Effect.fail(
    new RemoteRefInvalidError({
      ref,
      message: `Invalid project ref format. Must be like: abcdefghijklmnopqrst`,
    }),
  );
}

/**
 * Lists every `[remotes.<name>]` entry off an already-loaded, POST-`env()`-
 * interpolation project config document (`LoadedProjectConfig.document`,
 * loaded WITHOUT a `projectRef` so no remote gets merged/stripped — see
 * `applyRemoteOverride` in `io.ts`). Reads the raw document rather than the
 * decoded `ProjectConfig` because the decoded shape defaults every remote's
 * full config subtree, which is irrelevant here and expensive to walk.
 */
export function listRemotesFromDocument(
  document: Record<string, unknown> | undefined,
): ReadonlyArray<RemoteEntry> {
  const remotes = document?.["remotes"];
  if (!isObject(remotes)) return [];
  const entries: Array<RemoteEntry> = [];
  for (const [name, remote] of Object.entries(remotes)) {
    const projectRef =
      isObject(remote) && typeof remote["project_id"] === "string" ? remote["project_id"] : "";
    entries.push({ name, projectRef });
  }
  return entries;
}

/**
 * Appends a `[remotes.<name>]\nproject_id = "<ref>"\n` block to raw TOML text
 * — every byte before the append offset is untouched (comments, key order,
 * whitespace), unlike `saveProjectConfig`'s full schema re-serialize, which
 * would also silently strip any hand-authored `[remotes.*]` subsection this
 * package's schema doesn't know about yet. Caller is responsible for the
 * idempotency/conflict decision (see `addRemote`) — this always appends.
 */
export function appendRemoteBlockToml(content: string, name: string, ref: string): string {
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  const leadingBlank = content.trim().length === 0 ? "" : "\n";
  return `${content}${separator}${leadingBlank}[remotes.${name}]\nproject_id = "${ref}"\n`;
}

/**
 * Removes exactly the `[remotes.<name>]` section's lines from raw TOML text —
 * from its header line up to (but not including) the next top-level-or-nested
 * `[...]` table header, or EOF. Caller must have already verified (via the
 * parsed document) that the block holds only `project_id`, so this line-based
 * scan can never truncate a sibling remote's own subsection by mistake: a
 * removable block by definition has no lines of its own beyond the header and
 * the single `project_id` line.
 */
export function removeRemoteBlockToml(content: string, name: string): string {
  const headerPattern = new RegExp(`^\\[remotes\\.${name}\\]\\s*$`);
  const lines = content.split("\n");
  const headerIndex = lines.findIndex((line) => headerPattern.test(line.trim()));
  if (headerIndex === -1) return content;

  let endIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (lines[i]?.trimStart().startsWith("[")) {
      endIndex = i;
      break;
    }
  }

  // Drop a single leading blank line immediately before the removed block —
  // `appendRemoteBlockToml` always inserts one — so repeated add/remove
  // cycles don't accumulate blank lines.
  const removeFrom =
    headerIndex > 0 && (lines[headerIndex - 1]?.trim() ?? "") === ""
      ? headerIndex - 1
      : headerIndex;
  const result = [...lines.slice(0, removeFrom), ...lines.slice(endIndex)];
  // `content.split("\n")`'s trailing `""` element (present iff `content` ends
  // in a newline) is lost when the removed block ran all the way to EOF
  // (`endIndex === lines.length` consumes it too) — restore it so a
  // newline-terminated file stays newline-terminated after removal.
  if (
    endIndex === lines.length &&
    lines[lines.length - 1] === "" &&
    result[result.length - 1] !== ""
  ) {
    result.push("");
  }
  return result.join("\n");
}

/** Extra keys (beyond `project_id`) a `[remotes.<name>]` block declares — a non-empty result blocks removal. */
function extraRemoteBlockKeys(remote: unknown): ReadonlyArray<string> {
  if (!isObject(remote)) return [];
  return Object.keys(remote).filter((key) => key !== "project_id");
}

export interface RemoteAddResult {
  readonly path: string;
  /** `false` when the name already existed with the identical ref. */
  readonly wrote: boolean;
}

export interface RemoteRemoveResult {
  readonly path: string;
}

/**
 * Adds `[remotes.<name>]` with `project_id = "<ref>"` to the project's config
 * file (TOML: append-only; JSON: structural insert, key order preserved).
 * Returns `null` when no `supabase/config.{toml,json}` exists — callers
 * decide how to surface that.
 */
export const addRemote = Effect.fnUntraced(function* (options: {
  readonly cwd: string;
  readonly name: string;
  readonly projectRef: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const project = yield* findProjectPaths(options.cwd);
  if (project === null) return null;

  yield* validateRemoteName(options.name);
  yield* validateRemoteRef(options.projectRef);

  const filePath = project.configPath;
  const isJson = filePath.endsWith(".json");
  const content = yield* fs.readFileString(filePath);

  const parsed: unknown = isJson ? JSON.parse(content) : SmolToml.parse(content);
  const remotes = isObject(parsed) && isObject(parsed["remotes"]) ? parsed["remotes"] : {};
  const existing = remotes[options.name];
  if (isObject(existing) && typeof existing["project_id"] === "string") {
    if (existing["project_id"] === options.projectRef) {
      return { path: filePath, wrote: false } satisfies RemoteAddResult;
    }
    return yield* Effect.fail(
      new RemoteNameConflictError({
        name: options.name,
        message: `remote "${options.name}" already exists with a different project_id`,
      }),
    );
  }

  if (isJson) {
    const doc = isObject(parsed) ? { ...parsed } : {};
    const nextRemotes = { ...(isObject(doc["remotes"]) ? doc["remotes"] : {}) };
    nextRemotes[options.name] = { project_id: options.projectRef };
    doc["remotes"] = nextRemotes;
    yield* writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  } else {
    yield* writeFileAtomic(
      filePath,
      appendRemoteBlockToml(content, options.name, options.projectRef),
    );
  }

  return { path: filePath, wrote: true } satisfies RemoteAddResult;
});

/**
 * Removes `[remotes.<name>]`, refusing when the block declares keys beyond
 * `project_id`. Returns `null` when no config file exists.
 */
export const removeRemote = Effect.fnUntraced(function* (options: {
  readonly cwd: string;
  readonly name: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const project = yield* findProjectPaths(options.cwd);
  if (project === null) return null;

  yield* validateRemoteName(options.name);

  const filePath = project.configPath;
  const isJson = filePath.endsWith(".json");
  const content = yield* fs.readFileString(filePath);
  const parsed: unknown = isJson ? JSON.parse(content) : SmolToml.parse(content);
  const remotes = isObject(parsed) && isObject(parsed["remotes"]) ? parsed["remotes"] : {};
  const remote = remotes[options.name];
  if (remote === undefined) {
    return yield* Effect.fail(
      new RemoteNotFoundError({
        name: options.name,
        message: `remote "${options.name}" not found`,
      }),
    );
  }

  const extraKeys = extraRemoteBlockKeys(remote);
  if (extraKeys.length > 0) {
    return yield* Effect.fail(
      new RemoteBlockNotRemovableError({
        name: options.name,
        extraKeys,
        message: `remote "${options.name}" declares additional config beyond project_id (${extraKeys.join(", ")}); remove those keys first`,
      }),
    );
  }

  if (isJson) {
    const doc = isObject(parsed) ? { ...parsed } : {};
    const nextRemotes = { ...(isObject(doc["remotes"]) ? doc["remotes"] : {}) };
    delete nextRemotes[options.name];
    if (Object.keys(nextRemotes).length === 0) {
      delete doc["remotes"];
    } else {
      doc["remotes"] = nextRemotes;
    }
    yield* writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  } else {
    yield* writeFileAtomic(filePath, removeRemoteBlockToml(content, options.name));
  }

  return { path: filePath } satisfies RemoteRemoveResult;
});

/**
 * Pure config read listing every `[remotes.*]` entry off the POST-`env()`-interpolation
 * document, callers resolving a `--remote <name>` to a real ref need the ACTUAL value,
 * not a literal `env(REF)` string. No `projectRef` is passed to `loadProjectConfig`,
 * so no remote gets merged/stripped and every entry stays visible. Returns `null`
 * when no config file exists.
 */
export const listRemotes = Effect.fnUntraced(function* (cwd: string) {
  const loaded = yield* loadProjectConfig(cwd);
  if (loaded === null) return null;
  return listRemotesFromDocument(loaded.document);
});
