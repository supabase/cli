import type { Crypto, Effect, FileSystem, Path } from "effect";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import { runPostgresClient as runPreparedPostgresClient } from "../runtime/postgres-client.ts";
import type { PostgresClientMount } from "../runtime/postgres-client-args.ts";
import type { PostgresClientRunError } from "./Errors.ts";
import type { StackRuntimePreference } from "./Runtime.ts";

export type { PostgresClientMount };

export interface RunPostgresClientOptions<E> {
  /** Exact catalog release or major selector such as `"17"`. */
  readonly version?: string;
  /** Omitted preference uses Docker when installed, otherwise native. */
  readonly runtime?: StackRuntimePreference;
  readonly argv: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly mounts?: ReadonlyArray<PostgresClientMount>;
  readonly network?: "host" | { readonly name: string };
  readonly extraHosts?: ReadonlyArray<string>;
  readonly securityOpt?: ReadonlyArray<string>;
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  readonly teeStderr?: boolean;
  readonly captureStderr?: boolean;
}

export interface PostgresClientResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export type PostgresClientServices =
  | ChildProcessSpawnerService
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto;

/** Runs `argv` against a prepared catalog Postgres artifact or image. */
export const runPostgresClient = <E>(
  options: RunPostgresClientOptions<E>,
): Effect.Effect<PostgresClientResult, E | PostgresClientRunError, PostgresClientServices> =>
  runPreparedPostgresClient(options);
