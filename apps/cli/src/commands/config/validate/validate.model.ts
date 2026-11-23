import type { CliConfigLocation } from "@supabase/config/internal";

type ProblemCode =
  | "syntax"
  | "file_conflict"
  | "schema_version"
  | "removed_key"
  | "unknown_key"
  | "invalid_type"
  | "invalid_enum"
  | "invalid_value"
  | "missing_required"
  | "remote_project_id"
  | "env_file"
  | "env_unset"
  | "env_empty"
  | "deprecated_key"
  | "shadowed_file"
  | "unrecognized_schema";

export interface ConfigProblem {
  readonly code: ProblemCode;
  readonly severity: "error" | "warning";
  /** The key's path segments with any `remotes.<name>.` prefix removed. */
  readonly path?: ReadonlyArray<string>;
  readonly remote?: string;
  /** True when `remote` is the context and the key is written in the base block. */
  readonly inBase?: true;
  /** Names the file a pathless problem is about when it is not the validated one. */
  readonly subject?: string;
  /** Names a pathless problem's subject in the text report when no file is associated with it. */
  readonly label?: string;
  /** What is wrong, short and free of configured values. */
  readonly reason: string;
  readonly help?: string;
  readonly location?: CliConfigLocation;
}

/** Splits a `remotes.<name>.…` path into the remote and the path inside it. */
export function splitRemotePath(path: ReadonlyArray<string>): {
  readonly remote?: string;
  readonly path: ReadonlyArray<string>;
} {
  const [head, name] = path;
  return head === "remotes" && name !== undefined
    ? { remote: name, path: path.slice(2) }
    : { path };
}

/** A key path as shown to people; segments that contain dots are indistinguishable from nesting. */
export const displayPath = (path: ReadonlyArray<string>): string => path.join(".");
