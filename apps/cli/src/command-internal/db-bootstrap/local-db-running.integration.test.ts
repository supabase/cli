import { BunHttpServer, BunServices, BunSocketServer } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path, Schedule, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { configValuesLayer } from "../../../tests/helpers/config-values-layer.ts";
import { mockContainerCliSpawner } from "../../../tests/helpers/local-reset.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { DebugLogger } from "../../shared/output/debug-logger.service.ts";
import { runtimeInfoLayer } from "../../shared/runtime/runtime-info.layer.ts";
import {
  LocalDockerEngine,
  dockerEndpointSocketPath,
  isLocalDbRunning,
  localDbState,
  localDockerEngineLayer,
} from "./local-db-running.ts";

describe("dockerEndpointSocketPath", () => {
  it("maps a unix:// endpoint to its filesystem path", () => {
    expect(dockerEndpointSocketPath("unix:///var/run/docker.sock")).toBe("/var/run/docker.sock");
  });

  it("maps an npipe:// endpoint to its \\\\.\\pipe form", () => {
    expect(dockerEndpointSocketPath("npipe:////./pipe/dockerDesktopLinuxEngine")).toBe(
      "\\\\.\\pipe\\dockerDesktopLinuxEngine",
    );
  });

  it("declines every endpoint the direct transport cannot address", () => {
    expect(dockerEndpointSocketPath("tcp://localhost:2375")).toBeUndefined();
    expect(dockerEndpointSocketPath("ssh://user@remote-host")).toBeUndefined();
    expect(dockerEndpointSocketPath("fd://")).toBeUndefined();
    expect(dockerEndpointSocketPath("unix://")).toBeUndefined();
  });
});

function withDockerHost<A, E, R>(
  endpoint: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: { DOCKER_HOST: endpoint }, preserveEmptyStrings: true }),
    ),
  );
}

const ENGINE_IDENTITY_HEADERS = { "api-version": "1.55" };

const engineJson = (status: number, body: string) =>
  HttpServerResponse.text(body, {
    status,
    headers: ENGINE_IDENTITY_HEADERS,
    contentType: "application/json",
  });

const makeEngineServer = (
  respond: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ldbeng-" });
    const socketPath = path.join(dir, "d.sock");
    const requestedUrls: Array<string> = [];
    const server = yield* BunHttpServer.make({ unix: socketPath });
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        requestedUrls.push(request.url);
        return yield* respond(request);
      }),
    );
    return { socketPath, requestedUrls };
  });

/*
 * A raw-socket peer for wire shapes an HTTP server will not produce: it reads
 * the request head, writes `reply` verbatim, then closes the connection. With
 * no `reply` it holds the connection open without answering.
 */
const makeRawEngineServer = (reply: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ldbraw-" });
    const socketPath = path.join(dir, "d.sock");
    const server = yield* BunSocketServer.make({ path: socketPath });
    yield* server
      .run((socket) =>
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            const decoder = new TextDecoder();
            let head = "";
            while (!head.includes("\r\n\r\n")) {
              for (const chunk of yield* reader.pull) {
                head += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
              }
            }
            if (reply === undefined) return yield* Effect.never;
            yield* writer.write(reply);
          }),
        ),
      )
      .pipe(Effect.forkScoped);
    return { socketPath };
  });

const missingSocketEndpoint = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ldbgone-" });
  return `unix://${path.join(dir, "never-created.sock")}`;
});

const localDockerEngineTestLayer = localDockerEngineLayer.pipe(
  Layer.provide(BunServices.layer),
  Layer.provide(runtimeInfoLayer),
);

const engineInspectContainer = (containerId: string) =>
  Effect.gen(function* () {
    const engine = yield* LocalDockerEngine;
    return yield* engine.inspectContainer(containerId);
  }).pipe(Effect.provide(localDockerEngineTestLayer));

describe("LocalDockerEngine (direct Engine-API transport)", () => {
  describe.skipIf(process.platform === "win32")("over a per-test unix-socket Engine server", () => {
    it.live("answers present for an Engine 200 inspect payload on the documented route", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer(() =>
            Effect.succeed(
              engineJson(
                200,
                JSON.stringify({ Id: "abc123", State: { Running: true, Status: "running" } }),
              ),
            ),
          );
          const answer = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineInspectContainer("supabase_db_engine-probe"),
          );
          expect(answer).toEqual(Option.some({ exists: true, running: true, status: "running" }));
          expect(engine.requestedUrls).toEqual(["/containers/supabase_db_engine-probe/json"]);
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live.each([
      ["a stopped container", { Running: false, Status: "exited" }, false, "exited"],
      ["a created container", { Running: false, Status: "created" }, false, "created"],
      ["a running container", { Running: true, Status: "running" }, true, "running"],
      ["a missing State", undefined, true, ""],
      ["a non-object State", "exited", true, ""],
    ] as const)(
      "reports %s from the Engine inspect payload's State",
      ([, state, running, status]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* makeEngineServer(() =>
              Effect.succeed(
                engineJson(
                  200,
                  JSON.stringify({
                    Id: "abc123",
                    ...(state === undefined ? {} : { State: state }),
                  }),
                ),
              ),
            );
            const answer = yield* withDockerHost(
              `unix://${engine.socketPath}`,
              engineInspectContainer("supabase_db_engine-probe"),
            );
            expect(answer).toEqual(Option.some({ exists: true, running, status }));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("answers absent for an Engine 404", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer(() =>
            Effect.succeed(engineJson(404, JSON.stringify({ message: "No such container" }))),
          );
          const answer = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineInspectContainer("supabase_db_engine-probe"),
          );
          expect(answer).toEqual(Option.some({ exists: false }));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("gives no answer for a responder that does not identify as a Docker engine", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer((request) => {
            if (request.url.includes("present")) {
              return Effect.succeed(
                HttpServerResponse.text(JSON.stringify({ Id: "not-an-engine" }), {
                  status: 200,
                  contentType: "application/json",
                }),
              );
            }
            if (request.url.includes("server-header")) {
              return Effect.succeed(
                HttpServerResponse.text(JSON.stringify({ message: "No such container" }), {
                  status: 404,
                  headers: { server: "Docker/28.5.2 (linux)" },
                }),
              );
            }
            return Effect.succeed(HttpServerResponse.empty({ status: 404 }));
          });
          const present = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineInspectContainer("present"),
          );
          const absent = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineInspectContainer("absent"),
          );
          const viaServerHeader = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineInspectContainer("server-header"),
          );
          expect(present).toEqual(Option.none());
          expect(absent).toEqual(Option.none());
          expect(viaServerHeader).toEqual(Option.some({ exists: false }));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("gives no answer for an empty or malformed Engine 200 body", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer((request) =>
            Effect.succeed(
              engineJson(
                200,
                request.url.includes("empty") ? "" : JSON.stringify(["not", "an", "object"]),
              ),
            ),
          );
          const empty = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineInspectContainer("empty"),
          );
          const malformed = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineInspectContainer("malformed"),
          );
          expect(empty).toEqual(Option.none());
          expect(malformed).toEqual(Option.none());
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "gives no answer for an abnormal Engine status, so the container CLI reproduces it",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* makeEngineServer(() =>
              Effect.succeed(engineJson(500, JSON.stringify({ message: "layer store corrupted" }))),
            );
            const answer = yield* withDockerHost(
              `unix://${engine.socketPath}`,
              engineInspectContainer("supabase_db_engine-probe"),
            );
            expect(answer).toEqual(Option.none());
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "gives no answer when the endpoint accepts the connection but never responds",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* makeRawEngineServer(undefined);
            const answer = yield* withDockerHost(
              `unix://${engine.socketPath}`,
              engineInspectContainer("supabase_db_engine-probe"),
            );
            expect(answer).toEqual(Option.none());
          }),
        ).pipe(Effect.provide(BunServices.layer)),
      15_000,
    );

    it.live("gives no answer for an oversized body", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer(() =>
            Effect.succeed(engineJson(200, `{"Id":"${"a".repeat(80 * 1024)}"}`)),
          );
          const answer = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineInspectContainer("supabase_db_engine-probe"),
          );
          expect(answer).toEqual(Option.none());
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("gives no answer when the peer resets after the headers", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeRawEngineServer(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n" +
              'api-version: 1.55\r\n\r\n{"Id":',
          );
          const answer = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineInspectContainer("supabase_db_engine-probe"),
          );
          expect(answer).toEqual(Option.none());
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("traces the request, the decline, and the fallback through DebugLogger", () => {
      const lines: Array<string> = [];
      const recorder = Layer.succeed(DebugLogger, {
        debug: (line: string) =>
          Effect.sync(() => {
            lines.push(`debug:${line}`);
          }),
        http: (method: string, url: string) =>
          Effect.sync(() => {
            lines.push(`http:${method} ${url}`);
          }),
      });
      const traced = Effect.gen(function* () {
        const engine = yield* LocalDockerEngine;
        return yield* engine.inspectContainer("supabase_db_engine-probe");
      }).pipe(Effect.provide(localDockerEngineTestLayer.pipe(Layer.provide(recorder))));
      return Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer(() =>
            Effect.succeed(engineJson(404, JSON.stringify({ message: "No such container" }))),
          );
          yield* withDockerHost(`unix://${engine.socketPath}`, traced);
          expect(
            lines.some(
              (l) =>
                l.startsWith("http:GET unix://") &&
                l.includes("/containers/supabase_db_engine-probe/json"),
            ),
          ).toBe(true);
          // Plainly, then with a password a URL parser mis-locates, then with
          // no scheme for one to anchor on at all.
          yield* withDockerHost("ssh://user:hunter2@remote-host", traced);
          expect(
            lines.some(
              (l) => l.startsWith("debug:") && l.includes("not directly addressable (ssh)"),
            ),
          ).toBe(true);
          expect(lines.some((l) => l.includes("hunter2") || l.includes("remote-host"))).toBe(false);
          yield* withDockerHost("tcp://user:#hunter3@10.0.0.5:2376", traced);
          expect(lines.some((l) => l.includes("not directly addressable (tcp)"))).toBe(true);
          expect(lines.some((l) => l.includes("hunter3") || l.includes("10.0.0.5"))).toBe(false);
          yield* withDockerHost("deploy:hunter4@10.0.0.5:2376", traced);
          expect(lines.some((l) => l.includes("not directly addressable (no scheme)"))).toBe(true);
          expect(lines.some((l) => l.includes("hunter4") || l.includes("deploy"))).toBe(false);
          yield* withDockerHost(yield* missingSocketEndpoint, traced);
          expect(
            lines.some((l) => l.startsWith("debug:") && l.includes("no definitive Engine answer")),
          ).toBe(true);
        }),
      ).pipe(Effect.provide(BunServices.layer));
    });

    it.live(
      "gives no answer at the wall-clock deadline when the peer trickles bytes forever",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const drip = new TextEncoder().encode("a");
            const engine = yield* makeEngineServer(() =>
              Effect.succeed(
                HttpServerResponse.stream(
                  Stream.fromSchedule(Schedule.spaced("500 millis")).pipe(Stream.as(drip)),
                  {
                    status: 200,
                    headers: ENGINE_IDENTITY_HEADERS,
                    contentType: "application/json",
                  },
                ),
              ),
            );
            const answer = yield* withDockerHost(
              `unix://${engine.socketPath}`,
              engineInspectContainer("supabase_db_engine-probe"),
            );
            expect(answer).toEqual(Option.none());
          }),
        ).pipe(Effect.provide(BunServices.layer)),
      15_000,
    );
  });

  it.live("gives no answer when the local socket cannot be dialed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const answer = yield* withDockerHost(
          yield* missingSocketEndpoint,
          engineInspectContainer("supabase_db_engine-probe"),
        );
        expect(answer).toEqual(Option.none());
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("gives no answer for an endpoint the transport cannot address (ssh)", () =>
    withDockerHost(
      "ssh://user@remote-host",
      engineInspectContainer("supabase_db_engine-probe"),
    ).pipe(
      Effect.map((answer) => {
        expect(answer).toEqual(Option.none());
      }),
    ),
  );
});

describe("isLocalDbRunning", () => {
  const probe = (
    spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
    options: { readonly toml?: string; readonly env?: Readonly<Record<string, string>> } = {
      toml: 'project_id = "engine-probe"\n',
    },
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "ldbrun-" });
        if (options.toml !== undefined) {
          yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
          yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), options.toml);
        }
        return yield* isLocalDbRunning(spawner, fs, path, workdir);
      }),
    ).pipe(
      Effect.provide(
        configValuesLayer({ output: mockOutput().layer, env: options.env }).pipe(
          Layer.provideMerge(Layer.mergeAll(BunServices.layer, spawnerLayer)),
        ),
      ),
    );

  it.live("probes the container named by config.toml's project_id", () => {
    const asked: Array<string> = [];
    const mock = mockContainerCliSpawner(() => ({ exitCode: 0 }));
    return probe(mock.layer, { toml: 'project_id = "tomlproj"\n' }).pipe(
      Effect.provideService(LocalDockerEngine, {
        inspectContainer: (containerId) =>
          Effect.sync(() => {
            asked.push(containerId);
          }).pipe(Effect.as(Option.some({ exists: true, running: true, status: "running" }))),
      }),
      Effect.map(() => {
        expect(asked).toEqual(["supabase_db_tomlproj"]);
      }),
    );
  });

  it.live("probes the container named by SUPABASE_PROJECT_ID over config.toml's project_id", () => {
    const asked: Array<string> = [];
    const mock = mockContainerCliSpawner(() => ({ exitCode: 0 }));
    return probe(mock.layer, {
      toml: 'project_id = "tomlproj"\n',
      env: { SUPABASE_PROJECT_ID: "envproj" },
    }).pipe(
      Effect.provideService(LocalDockerEngine, {
        inspectContainer: (containerId) =>
          Effect.sync(() => {
            asked.push(containerId);
          }).pipe(Effect.as(Option.some({ exists: true, running: true, status: "running" }))),
      }),
      Effect.map(() => {
        expect(asked).toEqual(["supabase_db_envproj"]);
      }),
    );
  });

  it.live("trusts a definitive Engine answer without spawning the container CLI", () => {
    const asked: Array<string> = [];
    const mock = mockContainerCliSpawner(() => ({ exitCode: 0 }));
    return probe(mock.layer).pipe(
      Effect.provideService(LocalDockerEngine, {
        inspectContainer: (containerId) =>
          Effect.sync(() => {
            asked.push(containerId);
          }).pipe(Effect.as(Option.some({ exists: true, running: true, status: "running" }))),
      }),
      Effect.map((running) => {
        expect(running).toBe(true);
        expect(asked).toEqual(["supabase_db_engine-probe"]);
        expect(mock.spawned).toEqual([]);
      }),
    );
  });

  it.live("still reports a stopped container as present, from the Engine answer", () => {
    const mock = mockContainerCliSpawner(() => ({ exitCode: 0 }));
    return probe(mock.layer).pipe(
      Effect.provideService(LocalDockerEngine, {
        inspectContainer: () =>
          Effect.succeed(Option.some({ exists: true, running: false, status: "exited" })),
      }),
      Effect.map((exists) => {
        expect(exists).toBe(true);
        expect(mock.spawned).toEqual([]);
      }),
    );
  });

  it.live("still reports a stopped container as present, from the container CLI stdout", () => {
    const mock = mockContainerCliSpawner(() => ({
      stdout: [JSON.stringify([{ State: { Running: false, Status: "exited" } }])],
    }));
    return probe(mock.layer).pipe(
      Effect.provideService(LocalDockerEngine, {
        inspectContainer: () => Effect.succeed(Option.none()),
      }),
      Effect.map((exists) => {
        expect(exists).toBe(true);
      }),
    );
  });

  it.live("trusts a definitive Engine 404 without spawning the container CLI", () => {
    const mock = mockContainerCliSpawner(() => ({ exitCode: 0 }));
    return probe(mock.layer).pipe(
      Effect.provideService(LocalDockerEngine, {
        inspectContainer: () => Effect.succeed(Option.some({ exists: false })),
      }),
      Effect.map((running) => {
        expect(running).toBe(false);
        expect(mock.spawned).toEqual([]);
      }),
    );
  });

  it.live("falls back to the container CLI when the Engine gives no answer", () => {
    const mock = mockContainerCliSpawner(() => ({
      exitCode: 1,
      stderr: ["Error response from daemon: No such container: supabase_db_engine-probe"],
    }));
    return probe(mock.layer).pipe(
      Effect.provideService(LocalDockerEngine, {
        inspectContainer: () => Effect.succeed(Option.none()),
      }),
      Effect.map((running) => {
        expect(running).toBe(false);
        expect(mock.spawned.map((s) => s.args)).toEqual([
          ["container", "inspect", "supabase_db_engine-probe"],
        ]);
      }),
    );
  });

  it.live(
    "composes: a real transport failure on the resolved endpoint falls through to the container CLI",
    () => {
      const mock = mockContainerCliSpawner(() => ({
        exitCode: 1,
        stderr: ["Error response from daemon: No such container: supabase_db_engine-probe"],
      }));
      return Effect.scoped(
        Effect.gen(function* () {
          const running = yield* withDockerHost(
            yield* missingSocketEndpoint,
            probe(mock.layer).pipe(Effect.provide(localDockerEngineTestLayer)),
          );
          expect(running).toBe(false);
          expect(mock.spawned.map((s) => s.args)).toEqual([
            ["container", "inspect", "supabase_db_engine-probe"],
          ]);
        }),
      ).pipe(Effect.provide(BunServices.layer));
    },
  );
});

describe("localDbState", () => {
  const stateOf = (spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "ldbstate-" });
        return yield* localDbState(spawner, fs, path, workdir, "engine-probe");
      }),
    ).pipe(
      Effect.provide(
        configValuesLayer({ output: mockOutput().layer }).pipe(
          Layer.provideMerge(Layer.mergeAll(BunServices.layer, spawnerLayer)),
        ),
      ),
      Effect.provideService(LocalDockerEngine, {
        inspectContainer: () => Effect.succeed(Option.none()),
      }),
    );

  it.live.each([
    ["a stopped container", { Running: false, Status: "exited" }, false, "exited"],
    ["a created container", { Running: false, Status: "created" }, false, "created"],
    ["a running container", { Running: true, Status: "running" }, true, "running"],
  ] as const)(
    "reads %s from the container CLI inspect stdout's State",
    ([, state, running, status]) => {
      const mock = mockContainerCliSpawner(() => ({
        stdout: [JSON.stringify([{ Id: "abc123", State: state }])],
      }));
      return stateOf(mock.layer).pipe(
        Effect.map((answer) => {
          expect(answer).toEqual({ exists: true, running, status });
          expect(mock.spawned.map((s) => s.args)).toEqual([
            ["container", "inspect", "supabase_db_engine-probe"],
          ]);
        }),
      );
    },
  );

  it.live.each([
    ["empty", ""],
    ["not JSON", "not json"],
    ["a JSON object rather than an array", '{"State":{"Running":false,"Status":"exited"}}'],
    ["an empty array", "[]"],
    ["an entry without State", '[{"Id":"abc123"}]'],
  ] as const)(
    "counts a container whose inspect stdout is %s as running when the exit code is 0",
    ([, stdout]) => {
      const mock = mockContainerCliSpawner(() => ({ stdout: stdout === "" ? [] : [stdout] }));
      return stateOf(mock.layer).pipe(
        Effect.map((answer) => {
          expect(answer).toEqual({ exists: true, running: true, status: "" });
        }),
      );
    },
  );

  it.live("answers absent when the container CLI reports no such container", () => {
    const mock = mockContainerCliSpawner(() => ({
      exitCode: 1,
      stderr: ["Error response from daemon: No such container: supabase_db_engine-probe"],
    }));
    return stateOf(mock.layer).pipe(
      Effect.map((answer) => {
        expect(answer).toEqual({ exists: false });
      }),
    );
  });

  it.live("fails with the daemon marker when the container CLI cannot reach the daemon", () => {
    const mock = mockContainerCliSpawner(() => ({
      exitCode: 1,
      stderr: ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock."],
    }));
    return stateOf(mock.layer).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toMatchObject({ _tag: "LocalDbRunningError", daemonDown: true });
      }),
    );
  });
});
