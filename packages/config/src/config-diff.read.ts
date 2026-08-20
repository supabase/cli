import type {
  ManagedConfigProperty,
  RemoteConfigBlock,
  RemoteProjectConfig,
} from "./config-diff.ts";

/**
 * Reader/constructor helpers for the managed-surface table
 * (`config-diff.managed.ts`, `config-diff.auth.ts`). Every reader descends the
 * loosely-typed v2 response with runtime guards and coerces the wire value to
 * the local schema's type, so the classifier compares like with like.
 */

export function isRemoteRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a nested value from a response block. `undefined` means "not
 * returned"; an explicit `null` also reads as not returned (the API uses it
 * for "no value set", e.g. `api.db_pool`).
 */
export function remoteValueAt(
  remote: RemoteProjectConfig,
  block: RemoteConfigBlock,
  segments: ReadonlyArray<string>,
): unknown {
  let current: unknown = remote[block];
  for (const segment of segments) {
    if (!isRemoteRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current === null ? undefined : current;
}

export type RemoteScalarKind = "string" | "number" | "boolean";

const REMOTE_BOOL_TRUE = new Set(["true", "1"]);
const REMOTE_BOOL_FALSE = new Set(["false", "0"]);

/**
 * Coerces a wire scalar to the local schema's primitive kind. Unconvertible
 * values pass through unchanged so drift against an unexpected wire shape is
 * reported rather than swallowed.
 */
export function coerceRemoteScalar(value: unknown, kind: RemoteScalarKind): unknown {
  if (value === undefined) {
    return undefined;
  }
  switch (kind) {
    case "number": {
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : value;
      }
      return value;
    }
    case "boolean": {
      if (typeof value === "string") {
        const lowered = value.trim().toLowerCase();
        if (REMOTE_BOOL_TRUE.has(lowered)) return true;
        if (REMOTE_BOOL_FALSE.has(lowered)) return false;
      }
      return value;
    }
    case "string": {
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return value;
    }
  }
}

export interface ManagedScalarOptions {
  /** Dotted local schema path. */
  readonly path: string;
  readonly block: RemoteConfigBlock;
  /** Segments below the block, e.g. `["postgres_settings", "work_mem"]`. */
  readonly remotePath: ReadonlyArray<string>;
  readonly kind: RemoteScalarKind;
  readonly secret?: boolean;
  readonly normalize?: (value: unknown) => unknown;
}

export function managedScalar(options: ManagedScalarOptions): ManagedConfigProperty {
  return {
    path: options.path,
    block: options.block,
    ...(options.secret === true ? { secret: true } : {}),
    ...(options.normalize === undefined ? {} : { normalize: options.normalize }),
    read: (remote) =>
      coerceRemoteScalar(remoteValueAt(remote, options.block, options.remotePath), options.kind),
  };
}

export interface ManagedListOptions {
  readonly path: string;
  readonly block: RemoteConfigBlock;
  readonly remotePath: ReadonlyArray<string>;
  readonly secret?: boolean;
}

/**
 * A local string-array property the wire reports either as a comma-joined
 * string (e.g. PostgREST's `db_schema`) or as an actual array.
 */
export function managedStringList(options: ManagedListOptions): ManagedConfigProperty {
  return {
    path: options.path,
    block: options.block,
    ...(options.secret === true ? { secret: true } : {}),
    read: (remote) => {
      const value = remoteValueAt(remote, options.block, options.remotePath);
      if (typeof value === "string") {
        return value === ""
          ? []
          : value
              .split(",")
              .map((element) => element.trim())
              .filter((element) => element !== "");
      }
      if (Array.isArray(value)) {
        return value;
      }
      return undefined;
    },
  };
}

/**
 * Canonicalizes byte-size values for comparison: the wire reports byte
 * counts (`52428800`) where the file writes human-readable sizes (`"50MiB"`).
 * 1024-based and case-insensitive with an optional `b`/`ib` suffix, matching
 * Go's `units.RAMInBytes` semantics used by the original config loader.
 * Unparseable strings pass through so they still compare (and report) as-is.
 */
export function normalizeByteSize(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const match = /^\s*(\d*\.?\d+)\s*([kmgtp]?)(?:i?b)?\s*$/i.exec(value);
  if (match === null) {
    return value;
  }
  const magnitude = Number(match[1]);
  const exponent = { "": 0, k: 1, m: 2, g: 3, t: 4, p: 5 }[match[2]!.toLowerCase()] ?? 0;
  return Math.floor(magnitude * 1024 ** exponent);
}
