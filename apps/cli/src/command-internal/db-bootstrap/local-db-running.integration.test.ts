import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mockContainerCliSpawner } from "../../../tests/helpers/local-reset.ts";
import { DebugLogger } from "../debug-logger.service.ts";
import {
  LocalDockerEngine,
  dockerEndpointSocketPath,
  isLocalDbRunning,
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
  return Effect.suspend(() => {
    const previous = process.env["DOCKER_HOST"];
    process.env["DOCKER_HOST"] = endpoint;
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env["DOCKER_HOST"];
          else process.env["DOCKER_HOST"] = previous;
        }),
      ),
    );
  });
}

const ENGINE_IDENTITY_HEADERS = { "api-version": "1.55" };

const makeEngineServer = (respond: (req: http.IncomingMessage, res: http.ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly socketPath: string;
      readonly requestedUrls: Array<string>;
      readonly server: http.Server;
      readonly dir: string;
    }>((resume) => {
      let settled = false;
      const dir = mkdtempSync(join(tmpdir(), "ldbeng-"));
      const socketPath = join(dir, "d.sock");
      const requestedUrls: Array<string> = [];
      const server = http.createServer((req, res) => {
        requestedUrls.push(req.url ?? "");
        respond(req, res);
      });
      server.once("error", (cause) => {
        if (settled) return;
        settled = true;
        rmSync(dir, { recursive: true, force: true });
        resume(Effect.die(cause));
      });
      server.listen(socketPath, () => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed({ socketPath, requestedUrls, server, dir }));
      });
      return Effect.sync(() => {
        settled = true;
        server.close();
        rmSync(dir, { recursive: true, force: true });
      });
    }),
    ({ dir, server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections?.();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resume(Effect.void);
        });
      }),
  );

const engineContainerExists = (containerId: string) =>
  Effect.gen(function* () {
    const engine = yield* LocalDockerEngine;
    return yield* engine.containerExists(containerId);
  }).pipe(Effect.provide(localDockerEngineLayer));

describe("LocalDockerEngine (direct Engine-API transport)", () => {
  describe.skipIf(process.platform === "win32")("over a per-test unix-socket Engine server", () => {
    it.live("answers present for an Engine 200 inspect payload on the documented route", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json", ...ENGINE_IDENTITY_HEADERS });
            res.end(JSON.stringify({ Id: "abc123", State: { Status: "created" } }));
          });
          const answer = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineContainerExists("supabase_db_engine-probe"),
          );
          expect(answer).toEqual(Option.some(true));
          expect(engine.requestedUrls).toEqual(["/containers/supabase_db_engine-probe/json"]);
        }),
      ),
    );

    it.live("answers absent for an Engine 404", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer((_req, res) => {
            res.writeHead(404, { "content-type": "application/json", ...ENGINE_IDENTITY_HEADERS });
            res.end(JSON.stringify({ message: "No such container" }));
          });
          const answer = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineContainerExists("supabase_db_engine-probe"),
          );
          expect(answer).toEqual(Option.some(false));
        }),
      ),
    );

    it.live("gives no answer for a responder that does not identify as a Docker engine", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer((req, res) => {
            if (req.url?.includes("present") === true) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ Id: "not-an-engine" }));
              return;
            }
            if (req.url?.includes("server-header") === true) {
              res.writeHead(404, { server: "Docker/28.5.2 (linux)" });
              res.end(JSON.stringify({ message: "No such container" }));
              return;
            }
            res.writeHead(404);
            res.end();
          });
          const present = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineContainerExists("present"),
          );
          const absent = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineContainerExists("absent"),
          );
          const viaServerHeader = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineContainerExists("server-header"),
          );
          expect(present).toEqual(Option.none());
          expect(absent).toEqual(Option.none());
          expect(viaServerHeader).toEqual(Option.some(false));
        }),
      ),
    );

    it.live("gives no answer for an empty or malformed Engine 200 body", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer((req, res) => {
            res.writeHead(200, { "content-type": "application/json", ...ENGINE_IDENTITY_HEADERS });
            res.end(
              req.url?.includes("empty") === true ? "" : JSON.stringify(["not", "an", "object"]),
            );
          });
          const empty = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineContainerExists("empty"),
          );
          const malformed = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineContainerExists("malformed"),
          );
          expect(empty).toEqual(Option.none());
          expect(malformed).toEqual(Option.none());
        }),
      ),
    );

    it.live(
      "gives no answer for an abnormal Engine status, so the container CLI reproduces it",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* makeEngineServer((_req, res) => {
              res.writeHead(500, {
                "content-type": "application/json",
                ...ENGINE_IDENTITY_HEADERS,
              });
              res.end(JSON.stringify({ message: "layer store corrupted" }));
            });
            const answer = yield* withDockerHost(
              `unix://${engine.socketPath}`,
              engineContainerExists("supabase_db_engine-probe"),
            );
            expect(answer).toEqual(Option.none());
          }),
        ),
    );

    it.live(
      "gives no answer when the endpoint accepts the connection but never responds",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* makeEngineServer(() => {});
            const answer = yield* withDockerHost(
              `unix://${engine.socketPath}`,
              engineContainerExists("supabase_db_engine-probe"),
            );
            expect(answer).toEqual(Option.none());
          }),
        ),
      15_000,
    );

    it.live("gives no answer for an oversized body", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json", ...ENGINE_IDENTITY_HEADERS });
            res.end(`{"Id":"${"a".repeat(80 * 1024)}"}`);
          });
          const answer = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineContainerExists("supabase_db_engine-probe"),
          );
          expect(answer).toEqual(Option.none());
        }),
      ),
    );

    it.live("gives no answer when the peer resets after the headers", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer((_req, res) => {
            res.writeHead(200, {
              "content-type": "application/json",
              "content-length": "1000",
              ...ENGINE_IDENTITY_HEADERS,
            });
            res.write('{"Id":');
            res.socket?.destroy();
          });
          const answer = yield* withDockerHost(
            `unix://${engine.socketPath}`,
            engineContainerExists("supabase_db_engine-probe"),
          );
          expect(answer).toEqual(Option.none());
        }),
      ),
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
        return yield* engine.containerExists("supabase_db_engine-probe");
      }).pipe(Effect.provide(localDockerEngineLayer.pipe(Layer.provide(recorder))));
      return Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineServer((_req, res) => {
            res.writeHead(404, { "content-type": "application/json", ...ENGINE_IDENTITY_HEADERS });
            res.end(JSON.stringify({ message: "No such container" }));
          });
          yield* withDockerHost(`unix://${engine.socketPath}`, traced);
          expect(
            lines.some(
              (l) =>
                l.startsWith("http:GET unix://") &&
                l.includes("/containers/supabase_db_engine-probe/json"),
            ),
          ).toBe(true);
          yield* withDockerHost("ssh://user@remote-host", traced);
          expect(
            lines.some((l) => l.startsWith("debug:") && l.includes("not directly addressable")),
          ).toBe(true);
          const missingDir = mkdtempSync(join(tmpdir(), "ldbgone-"));
          yield* withDockerHost(`unix://${join(missingDir, "never-created.sock")}`, traced).pipe(
            Effect.ensuring(
              Effect.sync(() => rmSync(missingDir, { recursive: true, force: true })),
            ),
          );
          expect(
            lines.some((l) => l.startsWith("debug:") && l.includes("no definitive Engine answer")),
          ).toBe(true);
        }),
      );
    });

    it.live(
      "gives no answer at the wall-clock deadline when the peer trickles bytes forever",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* makeEngineServer((_req, res) => {
              res.writeHead(200, {
                "content-type": "application/json",
                ...ENGINE_IDENTITY_HEADERS,
              });
              const drip = setInterval(() => {
                res.write("a");
              }, 500);
              res.on("close", () => {
                clearInterval(drip);
              });
            });
            const answer = yield* withDockerHost(
              `unix://${engine.socketPath}`,
              engineContainerExists("supabase_db_engine-probe"),
            );
            expect(answer).toEqual(Option.none());
          }),
        ),
      15_000,
    );
  });

  it.live("gives no answer when the local socket cannot be dialed", () => {
    const missingDir = mkdtempSync(join(tmpdir(), "ldbgone-"));
    return withDockerHost(
      `unix://${join(missingDir, "never-created.sock")}`,
      engineContainerExists("supabase_db_engine-probe"),
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(missingDir, { recursive: true, force: true }))),
      Effect.map((answer) => {
        expect(answer).toEqual(Option.none());
      }),
    );
  });

  it.live("gives no answer for an endpoint the transport cannot address (ssh)", () =>
    withDockerHost(
      "ssh://user@remote-host",
      engineContainerExists("supabase_db_engine-probe"),
    ).pipe(
      Effect.map((answer) => {
        expect(answer).toEqual(Option.none());
      }),
    ),
  );
});

describe("isLocalDbRunning", () => {
  const probe = (spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = mkdtempSync(join(tmpdir(), "ldbrun-"));
      return yield* isLocalDbRunning(spawner, fs, path, workdir, "engine-probe").pipe(
        Effect.ensuring(Effect.sync(() => rmSync(workdir, { recursive: true, force: true }))),
      );
    }).pipe(Effect.provide(spawnerLayer), Effect.provide(BunServices.layer));

  it.live("trusts a definitive Engine answer without spawning the container CLI", () => {
    const asked: Array<string> = [];
    const mock = mockContainerCliSpawner(() => ({ exitCode: 0 }));
    return probe(mock.layer).pipe(
      Effect.provideService(LocalDockerEngine, {
        containerExists: (containerId) =>
          Effect.sync(() => {
            asked.push(containerId);
          }).pipe(Effect.as(Option.some(true))),
      }),
      Effect.map((running) => {
        expect(running).toBe(true);
        expect(asked).toEqual(["supabase_db_engine-probe"]);
        expect(mock.spawned).toEqual([]);
      }),
    );
  });

  it.live("trusts a definitive Engine 404 without spawning the container CLI", () => {
    const mock = mockContainerCliSpawner(() => ({ exitCode: 0 }));
    return probe(mock.layer).pipe(
      Effect.provideService(LocalDockerEngine, {
        containerExists: () => Effect.succeed(Option.some(false)),
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
        containerExists: () => Effect.succeed(Option.none()),
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
      const missingDir = mkdtempSync(join(tmpdir(), "ldbgone-"));
      return withDockerHost(
        `unix://${join(missingDir, "never-created.sock")}`,
        probe(mock.layer).pipe(Effect.provide(localDockerEngineLayer)),
      ).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(missingDir, { recursive: true, force: true }))),
        Effect.map((running) => {
          expect(running).toBe(false);
          expect(mock.spawned.map((s) => s.args)).toEqual([
            ["container", "inspect", "supabase_db_engine-probe"],
          ]);
        }),
      );
    },
  );
});
