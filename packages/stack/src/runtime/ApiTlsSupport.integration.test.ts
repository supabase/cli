import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Path, Ref } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer, type Socket } from "node:net";
import { API_TLS_CHECK_PATH, makeHttpProxy } from "../HttpProxy.ts";
import { apiTlsRuntimeLabel, checkApiTlsReach, probeApiTls } from "./ApiTlsSupport.ts";
import { hostBash, onCi } from "../../tests/api-tls.ts";
import { DOCKER_HOST_ALIAS, type EngineTarget } from "./Container.ts";

/* The probe needs bash >= 4 on this host; without one these tests skip, and fail on CI. */
const bash = await Effect.runPromise(hostBash.pipe(Effect.provide(NodeServices.layer)));
const ci = Effect.runSync(onCi);

/* A container the fake engine lists, with its labels as `key=value`. */
interface ListedContainer {
  readonly name: string;
  readonly labels: ReadonlyArray<string>;
}

/* Answers the engine's `ps` with `containers`, keeping only listed ones carrying every filtered
   label, and runs its `exec` scripts with this host's bash, where the stack alias is loopback, so
   the probe reaches the API port as a database container would; a `refusing` engine fails each
   exec, and a `writeAfterReset` engine holds the request until the listener reset the
   connection. `commands` records every engine command. */
const engineOnHost = (
  containers: string | ReadonlyArray<ListedContainer>,
  commands: Array<ReadonlyArray<string>> = [],
  refusing = false,
  writeAfterReset = false,
) =>
  Effect.gen(function* () {
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    if (bash === undefined)
      return yield* Effect.die(
        "the start check probe tests need bash >= 4 on PATH, /opt/homebrew/bin or /usr/local/bin (macOS ships 3.2: `brew install bash`)",
      );
    return ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) return delegate.spawn(command);
      commands.push(command.args.map(String));
      const [verb] = command.args;
      if (verb === "ps") {
        const args = command.args.map(String);
        const filters = args.flatMap((arg, index) =>
          args[index - 1] === "--filter" && arg.startsWith("label=") ? [arg.slice(6)] : [],
        );
        const listed =
          typeof containers === "string"
            ? containers
            : containers
                .filter(({ labels }) => filters.every((label) => labels.includes(label)))
                .map(({ name }) => `${name}\n`)
                .join("");
        return delegate.spawn(ChildProcess.make("printf", ["%s", listed]));
      }
      if (refusing)
        return delegate.spawn(
          ChildProcess.make(bash, ["-c", "printf 'Error: container is not running' >&2; exit 1"]),
        );
      const script = command.args.at(-1);
      const held = writeAfterReset
        ? `printf() { unset -f printf; IFS= read -r -t 5 -u 3 _; builtin printf "$@"; }; `
        : "";
      return delegate.spawn(
        ChildProcess.make(bash, [
          "-c",
          typeof script === "string"
            ? `${held}${script.replaceAll(DOCKER_HOST_ALIAS, "127.0.0.1")}`
            : "",
        ]),
      );
    });
  });

/* The API port serving TLS, whose readiness route answers with what `answering` arms. */
const tlsProxy = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const certs = path.join(import.meta.dirname, "..", "..", "tests", "certs");
  const armed = yield* Ref.make<string | undefined>(undefined);
  const proxy = yield* makeHttpProxy({
    host: "127.0.0.1",
    port: 0,
    tls: {
      cert: yield* fs.readFileString(path.join(certs, "trusted.crt")),
      key: yield* fs.readFileString(path.join(certs, "localhost.key")),
      check: Ref.get(armed),
    },
  });
  const answering = <A, E>(body: string, check: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Ref.set(armed, body),
      () => check,
      () => Ref.set(armed, undefined),
    );
  return { port: proxy.port, armed, answering };
});

class ApiTlsTestError extends Data.TaggedError("ApiTlsTestError")<{ readonly message: string }> {}

/* A raw listener on loopback that hands each accepted connection, once its request arrived or on
   accept, to `reply`; it never closes what `reply` leaves open until the scope ends. */
const rawPort = (reply: (socket: Socket) => void, onAccept = false) =>
  Effect.gen(function* () {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      if (onAccept) reply(socket);
      else socket.once("data", () => reply(socket));
    });
    return yield* Effect.acquireRelease(
      Effect.callback<number, ApiTlsTestError>((resume) => {
        const onError = (cause: Error) =>
          resume(Effect.fail(new ApiTlsTestError({ message: cause.message })));
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", onError);
          const address = server.address();
          resume(
            address === null || typeof address === "string"
              ? Effect.fail(new ApiTlsTestError({ message: "no address" }))
              : Effect.succeed(address.port),
          );
        });
        return Effect.sync(() => server.off("error", onError));
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          for (const socket of sockets) socket.destroy();
        }),
    );
  });

const target: EngineTarget = { engine: "docker", argv: [], daemonId: "test" };
const stack = { id: "stack", root: "/data/stack", database: "db-instance" };
const body = "supabase-stack stack 3f1c";

class StopError extends Data.TaggedError("StopError")<{ readonly message: string }> {}

/* The start check on `port`, arming the readiness route through `answering` while it probes. */
const reach = (options: {
  readonly port: number;
  readonly answering?: <A, E>(body: string, check: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly stop: Effect.Effect<unknown, StopError>;
  readonly containers?: string;
  readonly refusing?: boolean;
  readonly writeAfterReset?: boolean;
  readonly readSeconds?: number;
}) =>
  Effect.gen(function* () {
    return yield* checkApiTlsReach({
      spawner: yield* engineOnHost(
        options.containers ?? "stack-db\n",
        [],
        options.refusing,
        options.writeAfterReset,
      ),
      target,
      stack,
      runtime: "test runtime",
      port: options.port,
      path: API_TLS_CHECK_PATH,
      answering: options.answering ?? (<A, E>(_body: string, check: Effect.Effect<A, E>) => check),
      body: Effect.succeed(body),
      stop: options.stop,
      ...(options.readSeconds === undefined ? {} : { readSeconds: options.readSeconds }),
    });
  });

describe.skipIf(bash === undefined && !ci)("start check probe over this host's bash", () => {
  it.live("passes start when the database container reads this check's readiness reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { port, armed, answering } = yield* tlsProxy;
        let stops = 0;
        yield* reach({
          port,
          answering,
          stop: Effect.sync(() => {
            stops += 1;
          }),
        });
        expect(stops).toBe(0);
        /* The route is armed only while the probe runs. */
        expect(yield* Ref.get(armed)).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("stops the stack and fails start on a close, a timeout or another reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { port } = yield* tlsProxy;
        let stops = 0;
        const stop = Effect.sync(() => {
          stops += 1;
        });
        const failed = (options: Omit<Parameters<typeof reach>[0], "stop">) =>
          Effect.flip(reach({ ...options, stop })).pipe(Effect.map(({ message }) => message));
        const foreign = (on: number, detail: string) =>
          `api.tls: the api port ${on} on test runtime isn't answering this stack's start check (${detail}); its services stopped: check what else listens on port ${on}, then start the stack again`;

        const unsupported =
          "api.tls: unsupported networking on test runtime: containers must reach the api from loopback (the database container's plain request was closed without a reply); its services stopped: turn off `[api.tls]`, or use a runtime whose containers reach this host from loopback (on macOS: Docker Desktop, colima or Podman machine), then start the stack again";
        const closing = yield* rawPort((socket) => socket.end());
        expect(yield* failed({ port: closing })).toBe(unsupported);
        const resetting = yield* rawPort((socket) => socket.resetAndDestroy(), true);
        expect(yield* failed({ port: resetting, writeAfterReset: true })).toBe(unsupported);
        const silent = yield* rawPort(() => undefined);
        expect(yield* failed({ port: silent, readSeconds: 1 })).toBe(
          foreign(silent, "no complete reply within 1 s"),
        );
        /* Unarmed, the readiness path is an unknown route. */
        expect(yield* failed({ port })).toBe(foreign(port, "replied HTTP/1.1 404 Not Found"));
        expect(stops).toBe(4);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("names what failed when the probe can't run, and the stack that did not stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { port, answering } = yield* tlsProxy;
        let stops = 0;
        const stop = Effect.sync(() => {
          stops += 1;
        });
        const unreachable = (detail: string) =>
          `api.tls: containers can't reach the api port ${port} on test runtime (${detail}); its services stopped: let test runtime containers reach the api port, or turn off \`[api.tls]\`, then start the stack again`;
        expect((yield* Effect.flip(reach({ port, answering, stop, containers: "" }))).message).toBe(
          unreachable("no database container"),
        );
        expect((yield* Effect.flip(reach({ port, answering, stop, refusing: true }))).message).toBe(
          unreachable(
            `probe failed for ${DOCKER_HOST_ALIAS}:${port}: Error: container is not running`,
          ),
        );
        expect(stops).toBe(2);
        const stuck = yield* Effect.flip(
          reach({ port, stop: Effect.fail(new StopError({ message: "engine gone" })) }),
        );
        expect(stuck.message).toBe(
          `api.tls: the api port ${port} on test runtime isn't answering this stack's start check (replied HTTP/1.1 404 Not Found); its services did not stop (engine gone), run \`supabase stack stop --stack-id stack\` to stop them`,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "probes from the primary database container, never a one-off job or data helper of the stack",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { port, answering } = yield* tlsProxy;
          const commands: Array<ReadonlyArray<string>> = [];
          const instance = [
            "com.supabase.stack=stack",
            "com.supabase.stack-root=/data/stack",
            "com.supabase.instance=db-instance",
          ];
          yield* answering(
            body,
            probeApiTls(
              yield* engineOnHost(
                [
                  {
                    name: "supabase-db-helper-1c2d3e4f",
                    labels: [...instance, "com.docker.compose.service=database-helper"],
                  },
                  {
                    name: "supabase-app-database-task-0a1b2c3d4e5f",
                    labels: [...instance, "com.supabase.service=database"],
                  },
                  {
                    name: "supabase-app-database-9f8e7d6c5b4a",
                    labels: [...instance, "com.supabase.service=database"],
                  },
                ],
                commands,
              ),
              target,
              stack,
              "test runtime",
              { port, path: API_TLS_CHECK_PATH, body },
            ),
          );
          expect(commands[0]).toEqual([
            "ps",
            "--filter",
            "label=com.supabase.stack=stack",
            "--filter",
            "label=com.supabase.stack-root=/data/stack",
            "--filter",
            "label=com.supabase.instance=db-instance",
            "--filter",
            "label=com.supabase.service=database",
            "--format",
            "{{.Names}}",
          ]);
          expect(commands.slice(1).map((args) => args.slice(0, 2))).toEqual([
            ["exec", "supabase-app-database-9f8e7d6c5b4a"],
          ]);
          const none = yield* Effect.flip(
            probeApiTls(
              yield* engineOnHost("supabase-app-database-task-0a1b2c3d4e5f\n"),
              target,
              stack,
              "test runtime",
              { port, path: API_TLS_CHECK_PATH, body },
            ),
          );
          expect(none.detail).toBe("no database container");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.live("has nothing to check while the API serves no TLS, and stops nothing", () =>
  Effect.gen(function* () {
    let stops = 0;
    yield* checkApiTlsReach({
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      target,
      stack,
      runtime: "test runtime",
      port: undefined,
      path: API_TLS_CHECK_PATH,
      answering: (_body, check) => check,
      body: Effect.succeed(body),
      stop: Effect.sync(() => {
        stops += 1;
      }),
    });
    expect(stops).toBe(0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("names the runtime by the host OS and the engine, rootless Podman included", () => {
  expect(apiTlsRuntimeLabel(target, "linux")).toBe("linux docker");
  expect(apiTlsRuntimeLabel({ ...target, engine: "podman", rootless: true }, "darwin")).toBe(
    "macos rootless podman",
  );
  expect(apiTlsRuntimeLabel({ ...target, engine: "podman", rootless: false }, "win32")).toBe(
    "windows podman",
  );
});
