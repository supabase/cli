import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeHttpProxy } from "../HttpProxy.ts";
import {
  apiTlsPeers,
  apiTlsSelfCheckPath,
  checkApiTlsReach,
  selfCheckApiTls,
} from "./ApiTlsSupport.ts";
import { captureLogs } from "../../tests/logs.ts";
import { DOCKER_HOST_ALIAS, type EngineTarget } from "./Container.ts";

/* Answers the engine's `ps` with `containers` and runs its `exec` scripts on this host, where the
   stack alias is loopback, so the probe reaches the proxy as a database container would; a
   `refusing` engine fails each exec echoing its script, token included, as its error. */
const engineOnHost = (
  containers: string,
  listings: Array<ReadonlyArray<string>> = [],
  refusing = false,
) =>
  Effect.gen(function* () {
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) return delegate.spawn(command);
      const [verb] = command.args;
      if (verb === "ps") {
        listings.push(command.args.map(String));
        return delegate.spawn(ChildProcess.make("printf", ["%s", containers]));
      }
      const script = command.args.at(-1);
      if (refusing)
        return delegate.spawn(
          ChildProcess.make("bash", [
            "-c",
            'printf %s "$1" >&2; exit 1',
            "_",
            typeof script === "string" ? script : "",
          ]),
        );
      return delegate.spawn(
        ChildProcess.make("bash", [
          "-c",
          typeof script === "string" ? script.replaceAll(DOCKER_HOST_ALIAS, "127.0.0.1") : "",
        ]),
      );
    });
  });

const tlsProxy = (token: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const certs = path.join(import.meta.dirname, "..", "..", "tests", "certs");
    const learned = new Set<string>();
    const proxy = yield* makeHttpProxy({
      host: "127.0.0.1",
      port: 0,
      tls: {
        cert: yield* fs.readFileString(path.join(certs, "trusted.crt")),
        key: yield* fs.readFileString(path.join(certs, "localhost.key")),
        plainPeer: (peer) => learned.has(peer),
        learn: { path: apiTlsSelfCheckPath(token), add: (peer) => learned.add(peer) },
      },
    });
    return { port: proxy.port, learned };
  });

const target: EngineTarget = { engine: "docker", argv: [], daemonId: "test" };
const stack = { id: "stack", root: "/data/stack" };

it.live("lets the database container's peer in and passes start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port, learned } = yield* tlsProxy("start-token");
      const spawner = yield* engineOnHost("stack-db\n");
      yield* selfCheckApiTls(
        spawner,
        target,
        stack,
        "test runtime",
        port,
        apiTlsSelfCheckPath("start-token"),
      );
      expect([...learned]).toEqual(["127.0.0.1"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("fails start when the container's request gets no HTTP reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port, learned } = yield* tlsProxy("start-token");
      const spawner = yield* engineOnHost("stack-db\n");
      const blocked = yield* Effect.flip(
        selfCheckApiTls(
          spawner,
          target,
          stack,
          "test runtime",
          port,
          apiTlsSelfCheckPath("another-start"),
        ),
      );
      expect(blocked.message).toBe("api.tls: containers can't reach the api on test runtime");
      expect(learned.size).toBe(0);
      const missing = yield* Effect.flip(
        selfCheckApiTls(
          yield* engineOnHost(""),
          target,
          stack,
          "test runtime",
          port,
          apiTlsSelfCheckPath("start-token"),
        ),
      );
      expect(missing).toMatchObject({
        message: "api.tls: containers can't reach the api on test runtime",
        detail: "no database container",
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("finds the database container by the stack's id and its data root", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port } = yield* tlsProxy("start-token");
      const listings: Array<ReadonlyArray<string>> = [];
      yield* selfCheckApiTls(
        yield* engineOnHost("stack-db\n", listings),
        target,
        stack,
        "test runtime",
        port,
        apiTlsSelfCheckPath("start-token"),
      );
      expect(listings).toEqual([
        [
          "ps",
          "--filter",
          "label=com.supabase.stack=stack",
          "--filter",
          "label=com.supabase.stack-root=/data/stack",
          "--filter",
          "label=com.supabase.service=database",
          "--format",
          "{{.Names}}",
        ],
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

class StopError extends Data.TaggedError("StopError")<{ readonly message: string }> {}

it.live("has nothing to check on a stack without an API port, and stops nothing", () =>
  Effect.gen(function* () {
    let stops = 0;
    yield* checkApiTlsReach({
      spawner: yield* engineOnHost(""),
      target,
      stack,
      apiTls: Effect.succeed({ runtime: "test runtime", selfCheck: "start-token" }),
      port: undefined,
      stop: Effect.sync(() => {
        stops += 1;
      }),
      learned: () => Effect.succeed([]),
      saveLearned: () => Effect.void,
    });
    expect(stops).toBe(0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("stops the stack when containers can't reach the API, naming what the probe saw", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port } = yield* tlsProxy("start-token");
      const check = (stop: Effect.Effect<void, StopError>, containers: string, refusing = false) =>
        Effect.gen(function* () {
          return yield* Effect.flip(
            checkApiTlsReach({
              spawner: yield* engineOnHost(containers, [], refusing),
              target,
              stack,
              apiTls: Effect.succeed({ runtime: "test runtime", selfCheck: "another-start" }),
              port,
              stop,
              learned: () => Effect.succeed([]),
              saveLearned: () => Effect.void,
            }),
          );
        });
      let stops = 0;
      const stopped = Effect.sync(() => {
        stops += 1;
      });
      expect((yield* check(stopped, "")).message).toBe(
        "api.tls: containers can't reach the api on test runtime (no database container)",
      );
      const blocked = yield* check(stopped, "stack-db\n");
      expect(blocked.message).toMatch(
        /^api\.tls: containers can't reach the api on test runtime \(.+\)$/u,
      );
      const refused = yield* check(stopped, "stack-db\n", true);
      expect(refused.message).toContain("__api_tls_self_check?token=<redacted>");
      expect(refused.message).not.toContain("another-start");
      expect(stops).toBe(3);
      const stuck = yield* check(Effect.fail(new StopError({ message: "engine gone" })), "");
      expect(stuck.message).toBe(
        "api.tls: containers can't reach the api on test runtime (no database container); its services did not stop (engine gone), run `supabase stack stop --stack-id stack` to stop them",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("warns and leaves subnets out when the engine can't inspect its default network", () => {
  const warnings: Array<string> = [];
  return Effect.gen(function* () {
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const failing = ChildProcessSpawner.make(() =>
      delegate.spawn(ChildProcess.make("bash", ["-c", "echo 'no such network' >&2; exit 1"])),
    );
    expect(yield* apiTlsPeers(failing, target, "linux")).toEqual({
      runtime: "linux docker",
      subnets: [],
    });
    expect(warnings).toEqual([
      "api.tls: can't read the docker bridge network's subnets, so only the start check admits containers: no such network",
    ]);
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, captureLogs(["Warn"])(warnings))));
});

it.live("stops the stack when its saved TLS can't be read after a start", () =>
  Effect.gen(function* () {
    let stops = 0;
    const read = (stop: Effect.Effect<void, StopError>) =>
      Effect.gen(function* () {
        return yield* Effect.flip(
          checkApiTlsReach({
            spawner: yield* engineOnHost(""),
            target,
            stack,
            apiTls: Effect.fail(new StopError({ message: "state.json unreadable" })),
            port: 54321,
            stop,
            learned: () => Effect.succeed([]),
            saveLearned: () => Effect.void,
          }),
        );
      });
    const unreadable = yield* read(
      Effect.sync(() => {
        stops += 1;
      }),
    );
    expect(unreadable.message).toBe(
      "api.tls: can't read the stack's saved TLS (state.json unreadable)",
    );
    expect(stops).toBe(1);
    const stuck = yield* read(Effect.fail(new StopError({ message: "engine gone" })));
    expect(stuck.message).toBe(
      "api.tls: can't read the stack's saved TLS (state.json unreadable); its services did not stop (engine gone), run `supabase stack stop --stack-id stack` to stop them",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("saves the peers the self-check let in with the stack's TLS", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port } = yield* tlsProxy("start-token");
      const saved: Array<ReadonlyArray<string>> = [];
      yield* checkApiTlsReach({
        spawner: yield* engineOnHost("stack-db\n"),
        target,
        stack,
        apiTls: Effect.succeed({ runtime: "test runtime", selfCheck: "start-token" }),
        port,
        stop: Effect.void,
        learned: (token) => Effect.succeed(token === "start-token" ? ["10.9.8.7"] : []),
        saveLearned: (peers) =>
          Effect.sync(() => {
            saved.push(peers);
          }),
      });
      expect(saved).toEqual([["10.9.8.7"]]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps a passing self-check when saving its learned peers fails", () => {
  const warnings: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const { port } = yield* tlsProxy("start-token");
      let stops = 0;
      yield* checkApiTlsReach({
        spawner: yield* engineOnHost("stack-db\n"),
        target,
        stack,
        apiTls: Effect.succeed({ runtime: "test runtime", selfCheck: "start-token" }),
        port,
        stop: Effect.sync(() => {
          stops += 1;
        }),
        learned: () => Effect.succeed(["10.9.8.7"]),
        saveLearned: () => Effect.fail(new StopError({ message: "state.json unwritable" })),
      });
      expect(stops).toBe(0);
      expect(warnings).toContain(
        "api.tls: can't save the peers the start check let in: state.json unwritable",
      );
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, captureLogs(["Warn"])(warnings))));
});
