import { NodeServices, NodeSocketServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { makePorts, PortError } from "./Ports.ts";
import * as State from "./State.ts";

const makeTestState = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

const bind = (host: string, port: number) =>
  NodeSocketServer.make({ host, port }).pipe(
    Effect.mapError((cause) => new PortError({ key: "sql", message: "Cannot bind", cause })),
  );

it.live("retains distinct claims for stopped stacks and rebinds the original public port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      for (const id of ["first", "second"])
        yield* state.save({
          id,
          runtime: "native",
          identity: { projectRoot: root, branchContext: "test", stackName: "ports" },
          instances: [],
          composition: { members: [], dependencies: [] },
          ports: [],
        });
      const ports = yield* makePorts(state);
      const firstScope = yield* Scope.make();
      const request = { stackId: "first", key: "db/sql", host: "127.0.0.1", port: "auto" as const };
      const first = yield* ports
        .acquire(request, bind)
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      yield* Scope.close(firstScope, Exit.void);
      const second = yield* ports.acquire({ ...request, stackId: "second" }, bind);
      expect(second.port).not.toBe(first.port);
      const reopened = yield* makePorts(yield* makeTestState(root));
      const again = yield* reopened.acquire(request, bind);
      expect(again.port).toBe(first.port);
      expect((yield* state.read("first"))?.ports).toEqual([
        { key: "db/sql", host: "127.0.0.1", port: first.port },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports an occupied saved port without moving its assignment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "test", stackName: "ports" },
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const ports = yield* makePorts(state);
      const scope = yield* Scope.make();
      const request = { stackId: "stack", key: "api", host: "127.0.0.1", port: "auto" as const };
      const first = yield* ports
        .acquire(request, bind)
        .pipe(Effect.provideService(Scope.Scope, scope));
      yield* Scope.close(scope, Exit.void);
      yield* bind("127.0.0.1", first.port);
      const failure = yield* ports.acquire(request, bind).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PortError);
      expect(failure.message).toContain(`api at 127.0.0.1:${first.port}`);
      expect((yield* state.read("stack"))?.ports[0]?.port).toBe(first.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses allocation when another stack has unreadable claims", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* state.save({
        id: "healthy",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "test", stackName: "ports" },
        instances: [],
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      yield* fs.makeDirectory(`${root}/broken`);
      yield* fs.writeFileString(`${root}/broken/state.json`, "{broken");
      const ports = yield* makePorts(state);
      const error = yield* ports
        .acquire({ stackId: "healthy", key: "sql", host: "127.0.0.1", port: "auto" }, bind)
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(State.StateError);
      expect((yield* state.read("healthy"))?.ports).toEqual([]);
      expect(yield* fs.readFileString(`${root}/broken/state.json`)).toBe("{broken");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
