import { Effect, Layer, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * A minimal `docker`/`podman` CLI spawner mock + default happy-path route for
 * `legacyResetLocalDatabase`'s real, native container-recreate flow — used
 * wherever a test now drives a REAL in-process local reset instead of a
 * subprocess/seam stub (CLI-2062: `db schema declarative`'s smart-target/sync
 * recovery reset). Mirrors `commands/db/reset/reset.integration.test.ts`'s own
 * `mockContainerCliSpawner`/`defaultLocalResetRoute` (that file predates this
 * hoist and keeps its own copy, adapted for its container-REMOVE-then-recreate
 * assertions) — same shape here, hoisted for the two `db schema declarative`
 * callers so they don't each duplicate it again.
 */

export interface LegacySpawnRecord {
  readonly args: ReadonlyArray<string>;
}

export type LegacyRouteResult = {
  readonly exitCode?: number;
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
};

export function mockContainerCliSpawner(route: (args: ReadonlyArray<string>) => LegacyRouteResult) {
  const spawned: Array<LegacySpawnRecord> = [];
  const encoder = new TextEncoder();

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args = command._tag === "StandardCommand" ? command.args : [];
        spawned.push({ args });

        if (command._tag !== "StandardCommand") {
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "spawn failed",
            }),
          );
        }

        const result = route(args);
        const stdoutBytes = (result.stdout ?? []).map((line) => encoder.encode(`${line}\n`));
        const stderrBytes = (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(6000 + spawned.length),
          stdout: Stream.fromIterable(stdoutBytes),
          stderr: Stream.fromIterable(stderrBytes),
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

  return {
    layer,
    get spawned() {
      return spawned;
    },
  };
}

export interface LegacyDefaultLocalResetRouteOpts {
  readonly running?: boolean;
  readonly kongMissing?: boolean;
  readonly kongNotRunning?: boolean;
  readonly storageMissing?: boolean;
}

const HEALTHY_STATE = '{"Running":true,"Status":"running","Health":{"Status":"healthy"}}';
const STOPPED_STATE = '{"Running":false,"Status":"exited"}';

function containerNameFromCreateArgs(args: ReadonlyArray<string>): string {
  const nameIndex = args.indexOf("--name");
  return nameIndex !== -1 ? (args[nameIndex + 1] ?? "unknown") : "unknown";
}

function fakeContainerId(name: string): string {
  return [...name]
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
}

/**
 * A happy-path Docker CLI route for `legacyResetLocalDatabase`'s PG15+
 * container-recreate — everything succeeds (running, healthy, no restart
 * failures) unless overridden. `projectId` must match the `LegacyCliConfig`
 * mock's own `projectId` (both default to `"test"`), since container names are
 * derived from it (`supabase_db_<project>`, `supabase_kong_<project>`,
 * `supabase_storage_<project>`).
 */
export function defaultLocalResetRoute(
  projectId = "test",
  opts: LegacyDefaultLocalResetRouteOpts = {},
) {
  const dbId = `supabase_db_${projectId}`;
  const kongId = `supabase_kong_${projectId}`;
  const storageId = `supabase_storage_${projectId}`;
  return (args: ReadonlyArray<string>): LegacyRouteResult => {
    if (args[0] === "image" && args[1] === "inspect") return { exitCode: 0 };
    if (args[0] === "context" && args[1] === "inspect") return { exitCode: 1 };
    if (args[0] === "container" && args[1] === "rm") return { exitCode: 0 };
    if (args[0] === "volume" && args[1] === "rm") return { exitCode: 0 };
    if (args[0] === "network" && args[1] === "create") return { exitCode: 0 };
    if (args[0] === "volume" && args[1] === "create") return { exitCode: 0 };
    if (args[0] === "create") {
      const name = containerNameFromCreateArgs(args);
      return { stdout: [fakeContainerId(name)] };
    }
    if (args[0] === "start") return { exitCode: 0 };
    if (args[0] === "restart") return { exitCode: 0 };
    if (args[0] === "exec" && args[1] === kongId) return { exitCode: 0 };
    if (args[0] === "container" && args[1] === "inspect") {
      const id = args[2] ?? "";
      if (id === kongId) {
        if (opts.kongMissing === true)
          return { exitCode: 1, stderr: [`Error: No such container: ${id}`] };
        return { stdout: [opts.kongNotRunning === true ? STOPPED_STATE : HEALTHY_STATE] };
      }
      if (id === storageId) {
        if (opts.storageMissing === true)
          return { exitCode: 1, stderr: [`Error: No such container: ${id}`] };
        return { stdout: [HEALTHY_STATE] };
      }
      if (id === dbId && opts.running === false) {
        return { exitCode: 1, stderr: [`Error: No such container: ${id}`] };
      }
      return { stdout: [HEALTHY_STATE] };
    }
    if (args[0] === "logs") return { exitCode: 0 };
    if (args[0] === "ps") return { stdout: [] };
    return { exitCode: 0 };
  };
}

/** Selects the `docker create` argv for the recreated `db` container, if any. */
export const legacyLocalResetCreateArgs = (
  spawned: ReadonlyArray<LegacySpawnRecord>,
): ReadonlyArray<string> | undefined => spawned.find((s) => s.args[0] === "create")?.args;

/** `docker container rm -f <id>` targets — the id is argv[3], after the `-f` flag at argv[2]. */
export const legacyLocalResetRemovedContainers = (
  spawned: ReadonlyArray<LegacySpawnRecord>,
): ReadonlyArray<string> =>
  spawned
    .filter((s) => s.args[0] === "container" && s.args[1] === "rm")
    .map((s) => s.args[3] ?? "");

/**
 * An HTTP client that answers every request with an empty `200 OK` — satisfies
 * `legacyAwaitStorageReady`'s static `HttpClient.HttpClient` requirement without
 * this route ever really being reached (storage health is checked purely via
 * the container-CLI spawner above).
 */
export const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);
