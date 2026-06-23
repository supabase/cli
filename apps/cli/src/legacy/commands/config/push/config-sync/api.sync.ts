import type { ProjectConfig } from "@supabase/config";

import { diff } from "./config-sync.diff.ts";
import { encodeToml, type TomlField, type TomlValue } from "./config-sync.toml.ts";
import { intToUint } from "../../../../shared/legacy-size-units.ts";

/**
 * Push-subset of Go's `api` struct (`pkg/config/api.go`). Only `toml`-tagged
 * fields are serialised — `toml:"-"` locals (`image`, `kong_image`, tls cert
 * contents) are excluded. Field order matches the Go struct declaration, which
 * the BurntSushi encoder preserves.
 */
export interface ApiSubset {
  readonly enabled: boolean;
  /** `nil` slice → omitted; empty slice → `[]`. */
  readonly schemas: ReadonlyArray<string> | undefined;
  readonly extra_search_path: ReadonlyArray<string> | undefined;
  readonly max_rows: number;
  /** `*bool, omitempty` — unset → omitted. */
  readonly auto_expose_new_tables: boolean | undefined;
  readonly port: number;
  readonly tls: {
    readonly enabled: boolean;
    readonly cert_path: string;
    readonly key_path: string;
  };
  readonly external_url: string;
}

/** Ordered field descriptor mirroring the `api` struct's toml tags. */
const API_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "schemas", node: { kind: "array", elem: { kind: "string" } } },
  { key: "extra_search_path", node: { kind: "array", elem: { kind: "string" } } },
  { key: "max_rows", node: { kind: "int" } },
  { key: "auto_expose_new_tables", node: { kind: "bool" }, omitempty: true },
  { key: "port", node: { kind: "int" } },
  {
    key: "tls",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "cert_path", node: { kind: "string" } },
        { key: "key_path", node: { kind: "string" } },
      ],
    },
  },
  { key: "external_url", node: { kind: "string" } },
];

/** The shape of the remote PostgREST config we read (Go `FromRemoteApiConfig`). */
export interface RemoteApiConfig {
  readonly db_schema: string;
  readonly db_extra_search_path: string;
  readonly max_rows: number;
}

/** Go `strToArr`: empty string → `[]`, else comma-split (no trimming here). */
function strToArr(v: string): Array<string> {
  return v.length === 0 ? [] : v.split(",");
}

/** Projects the loaded `config.api` into the push subset. */
export function apiSubsetFromConfig(config: ProjectConfig): ApiSubset {
  const api = config.api;
  return {
    enabled: api.enabled,
    schemas: api.schemas,
    extra_search_path: api.extra_search_path,
    max_rows: api.max_rows,
    auto_expose_new_tables: api.auto_expose_new_tables,
    port: api.port,
    tls: {
      enabled: api.tls.enabled,
      cert_path: api.tls.cert_path ?? "",
      key_path: api.tls.key_path ?? "",
    },
    external_url: api.external_url ?? "",
  };
}

/**
 * Port of Go `(*api).FromRemoteApiConfig`. Returns a copy of `local` with the
 * remote-derived fields applied. When the remote schema is empty the api is
 * disabled and the remaining fields are left as the local copy's values
 * (matching Go's early return).
 */
function applyRemoteApiConfig(local: ApiSubset, remote: RemoteApiConfig): ApiSubset {
  const enabled = remote.db_schema.length > 0;
  if (!enabled) {
    return { ...local, enabled: false };
  }
  return {
    ...local,
    enabled: true,
    schemas: strToArr(remote.db_schema).map((s) => s.trim()),
    extra_search_path: strToArr(remote.db_extra_search_path).map((s) => s.trim()),
    max_rows: intToUint(remote.max_rows),
  };
}

function toTomlValue(subset: ApiSubset): { readonly [k: string]: TomlValue | undefined } {
  return {
    enabled: subset.enabled,
    schemas: subset.schemas,
    extra_search_path: subset.extra_search_path,
    max_rows: subset.max_rows,
    auto_expose_new_tables: subset.auto_expose_new_tables,
    port: subset.port,
    tls: {
      enabled: subset.tls.enabled,
      cert_path: subset.tls.cert_path,
      key_path: subset.tls.key_path,
    },
    external_url: subset.external_url,
  };
}

/** Port of Go `(*api).DiffWithRemote`. Returns `""` when local matches remote. */
export function diffApiWithRemote(local: ApiSubset, remote: RemoteApiConfig): string {
  const currentValue = encodeToml(API_FIELDS, toTomlValue(local));
  const remoteCompare = encodeToml(API_FIELDS, toTomlValue(applyRemoteApiConfig(local, remote)));
  return diff("remote[api]", remoteCompare, "local[api]", currentValue);
}

/** Body fields for the PostgREST update request (Go `ToUpdatePostgrestConfigBody`). */
export interface ApiUpdateBody {
  db_schema?: string;
  db_extra_search_path?: string;
  max_rows?: number;
}

/** Port of Go `(*api).ToUpdatePostgrestConfigBody`. */
export function apiToUpdateBody(local: ApiSubset): ApiUpdateBody {
  // When the api is disabled, the remote just gets an empty db schema.
  if (!local.enabled) {
    return { db_schema: "" };
  }
  const body: ApiUpdateBody = {};
  const schemas = local.schemas ?? [];
  if (schemas.length > 0) {
    body.db_schema = schemas.join(",");
  }
  body.db_extra_search_path = (local.extra_search_path ?? []).join(",");
  if (local.max_rows > 0) {
    body.max_rows = local.max_rows;
  }
  return body;
}
