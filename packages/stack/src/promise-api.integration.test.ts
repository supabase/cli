import { NodeServices, NodeSocketServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Redacted, Schema } from "effect";
import { discover, StackError, type Observation } from "./index.ts";
import { createTestStack } from "./testing.ts";

const databaseSecret = (observation: Observation) =>
  observation.config.service === "database"
    ? observation.config.config.databasePassword
    : undefined;

it.live(
  "returns observations as data, with exits and Redacted secrets intact",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "stack-promise-state-" });
      const test = yield* Effect.acquireRelease(
        Effect.promise(() => createTestStack({ runtime: "native", stateRoot })),
        (created) => Effect.promise(() => created[Symbol.asyncDispose]()),
      );
      const database = test.services.database;

      yield* Effect.promise(() => database.stop());
      const stopped = yield* Effect.promise(() => database.status());
      expect(Exit.isExit(stopped.exit)).toBe(true);
      expect(Redacted.isRedacted(databaseSecret(stopped))).toBe(true);

      yield* Effect.promise(() => test.stack.composition.start());
      const members = yield* Effect.promise(() => test.stack.composition.stop());
      expect(members.length).toBeGreaterThan(0);
      for (const member of members) expect(Exit.isExit(member.exit)).toBe(true);
      expect(members.map(databaseSecret).filter(Redacted.isRedacted)).toHaveLength(1);

      const cancelled = yield* Effect.promise(() =>
        test.stack.composition.start({ signal: AbortSignal.abort() }).then(
          () => "resolved",
          () => "rejected",
        ),
      );
      expect(cancelled).toBe("rejected");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);

it.live(
  "rejects with the startup failure and removes the stack when Promise test startup fails",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "stack-promise-failure-" });
      const occupied = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 });
      if (occupied.address._tag !== "TcpAddress") return yield* Effect.die("Expected TCP");
      const port = occupied.address.port;

      const failure = yield* Effect.promise(() =>
        createTestStack({
          services: [{ service: "mail", endpoints: { http: { port } } }],
          runtime: "native",
          stateRoot,
        }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );

      expect(Schema.is(StackError)(failure)).toBe(true);
      expect(Schema.is(StackError)(failure) ? failure.operation : undefined).toBe("test-startup");
      expect(yield* Effect.promise(() => discover({ stateRoot }))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);
