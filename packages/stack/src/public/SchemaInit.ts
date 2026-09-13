import { Crypto, Effect, FileSystem, Path, Redacted } from "effect";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import type { SchemaInitError } from "./Errors.ts";
import type { StackConfig } from "./Config.ts";
import type { StackRuntime } from "./Runtime.ts";
import type { StackId } from "./StackId.ts";
import { schemaInitWorkloads, schemaInitArtifactIdentity } from "../runtime/SchemaInit.ts";
import type { ContainerEngine } from "../runtime/ContainerEngine.ts";
import type { RuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";

export { schemaInitArtifactIdentity };

export const SCHEMA_INIT_CAPABILITY_NAMES = [
  "auth",
  "storage",
  "realtime",
  "analytics",
  "pooler",
] as const;
export type SchemaInitCapabilityName = (typeof SCHEMA_INIT_CAPABILITY_NAMES)[number];

export interface SchemaInitSecrets {
  readonly databasePassword: Redacted.Redacted<string>;
  readonly jwtSecret?: Redacted.Redacted<string>;
}

interface SchemaInitTargetBase {
  readonly projectRoot: string;
  readonly runtime: StackRuntime;
  readonly config: StackConfig;
  readonly databaseUrl: string;
  readonly secrets: SchemaInitSecrets;
}

export interface SchemaInitLiveTarget extends SchemaInitTargetBase {
  readonly kind: "live";
  readonly stackId: StackId;
}

export interface SchemaInitEphemeralTarget extends SchemaInitTargetBase {
  readonly kind: "ephemeral";
}

export type SchemaInitTarget = SchemaInitLiveTarget | SchemaInitEphemeralTarget;

export interface SchemaInitOptions {
  readonly containerEngine?: ContainerEngine;
  readonly artifactPreparer?: RuntimeArtifactPreparer;
  /** Host OS used for Linux `host.docker.internal:host-gateway` extra hosts. */
  readonly platform?: string;
}

export type SchemaInitServices =
  | ChildProcessSpawnerService
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto;

/** Runs service-owned one-shots against a target Postgres without activating long-running processes. */
export const schemaInit = (
  names: ReadonlyArray<SchemaInitCapabilityName>,
  target: SchemaInitTarget,
  options: SchemaInitOptions = {},
): Effect.Effect<void, SchemaInitError, SchemaInitServices> =>
  schemaInitWorkloads(names, target, options);
