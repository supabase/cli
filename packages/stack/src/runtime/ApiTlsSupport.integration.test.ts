import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeHttpProxy } from "../HttpProxy.ts";
import {
  apiTlsPeers,
  apiTlsRuntimeLabel,
  apiTlsSelfCheckPath,
  checkApiTlsReach,
  selfCheckApiTls,
} from "./ApiTlsSupport.ts";
import { captureLogs } from "../../tests/logs.ts";
import { DOCKER_HOST_ALIAS, type EngineTarget } from "./Container.ts";

/* A container the fake engine lists, with its labels as `key=value`. */
interface ListedContainer {
  readonly name: string;
  readonly labels: ReadonlyArray<string>;
}

/* Answers the engine's `ps` with `containers`, keeping only listed ones carrying every filtered
   label, and its `inspect` with `networks`, and runs its `exec` scripts on this host, where the
   stack alias is loopback, so the probe reaches the proxy as a database container would; a
   `refusing` engine fails each exec echoing its script, token included, as its error. `commands`
   records every engine command. */
const engineOnHost = (
  containers: string | ReadonlyArray<ListedContainer>,
  commands: Array<ReadonlyArray<string>> = [],
  refusing = false,
  networks = "",
) =>
  Effect.gen(function* () {
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
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
      if (verb === "inspect") return delegate.spawn(ChildProcess.make("printf", ["%s", networks]));
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
const stack = { id: "stack", root: "/data/stack", database: "db-instance" };

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

it.live(
  "probes from the primary database container, never a one-off job or data helper of the stack",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { port } = yield* tlsProxy("start-token");
        const commands: Array<ReadonlyArray<string>> = [];
        const instance = [
          "com.supabase.stack=stack",
          "com.supabase.stack-root=/data/stack",
          "com.supabase.instance=db-instance",
        ];
        yield* selfCheckApiTls(
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
          port,
          apiTlsSelfCheckPath("start-token"),
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
          ["inspect", "supabase-app-database-9f8e7d6c5b4a"],
        ]);
        const none = yield* Effect.flip(
          selfCheckApiTls(
            yield* engineOnHost("supabase-app-database-task-0a1b2c3d4e5f\n"),
            target,
            stack,
            "test runtime",
            port,
            apiTlsSelfCheckPath("start-token"),
          ),
        );
        expect(none.detail).toBe("no database container");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reads the database container's networks once its request got a reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port } = yield* tlsProxy("start-token");
      const networks = yield* selfCheckApiTls(
        yield* engineOnHost("stack-db\n", [], false, "10.89.0.7/24 10.89.0.1\n/0 \n"),
        target,
        stack,
        "test runtime",
        port,
        apiTlsSelfCheckPath("start-token"),
      );
      expect(networks).toEqual([{ subnet: "10.89.0.0/24", gateway: "10.89.0.1" }]);
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
      runtime: "test runtime",
      apiTls: Effect.succeed({ selfCheck: "start-token" }),
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
              runtime: "test runtime",
              apiTls: Effect.succeed({ selfCheck: "another-start" }),
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

it.live("reads the subnet and gateway of the engine's default network", () =>
  Effect.gen(function* () {
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const inspecting = ChildProcessSpawner.make(() =>
      delegate.spawn(ChildProcess.make("printf", ["%s", "10.88.0.0/16 10.88.0.1\n"])),
    );
    expect(
      yield* apiTlsPeers(inspecting, { ...target, engine: "podman", rootless: false }),
    ).toEqual([{ subnet: "10.88.0.0/16", gateway: "10.88.0.1" }]);
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

it.live("warns and leaves subnets out when the engine can't inspect its default network", () => {
  const warnings: Array<string> = [];
  return Effect.gen(function* () {
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const failing = ChildProcessSpawner.make(() =>
      delegate.spawn(ChildProcess.make("bash", ["-c", "echo 'no such network' >&2; exit 1"])),
    );
    expect(yield* apiTlsPeers(failing, target)).toEqual([]);
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
            runtime: "test runtime",
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

it.live(
  "saves the peers and the containers' networks the self-check found with the stack's TLS",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { port } = yield* tlsProxy("start-token");
        const bridge = { subnet: "172.17.0.0/16", gateway: "172.17.0.1" };
        const saved: Array<unknown> = [];
        const adopted: Array<unknown> = [];
        const check = (peers: ReadonlyArray<string>, networks: string) =>
          Effect.gen(function* () {
            yield* checkApiTlsReach({
              spawner: yield* engineOnHost("stack-db\n", [], false, networks),
              target,
              stack,
              runtime: "test runtime",
              apiTls: Effect.succeed({ selfCheck: "start-token" }),
              port,
              stop: Effect.void,
              learned: (token, found) =>
                Effect.sync(() => {
                  adopted.push(found);
                  return token === "start-token" ? peers : [];
                }),
              saveLearned: (learned) =>
                Effect.sync(() => {
                  saved.push(learned);
                }),
            });
          });
        yield* check(["10.9.8.7"], "");
        /* A database admitted by the network rule learns no peer, but its network is saved. */
        yield* check([], "172.17.0.4/16 172.17.0.1\n");
        yield* check([], "");
        expect(adopted).toEqual([[], [bridge], []]);
        expect(saved).toEqual([
          { learnedPeers: ["10.9.8.7"], networks: [] },
          { learnedPeers: [], networks: [bridge] },
        ]);
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
        runtime: "test runtime",
        apiTls: Effect.succeed({ selfCheck: "start-token" }),
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
