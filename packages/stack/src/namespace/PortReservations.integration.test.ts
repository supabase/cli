import { homedir } from "node:os";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { randomUUID } from "node:crypto";
import * as PortReservations from "./PortReservations.ts";
import { openDatabase } from "./drivers/Sqlite.ts";

const openRegistry = Layer.build(PortReservations.layer).pipe(
  Effect.map((context) => Context.get(context, PortReservations.Service)),
);

it.live("opens and reads the registry while a peer connection holds its write lock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const registryFile = path.join(homedir(), ".supabase", "ports.sqlite");
      const stackId = `reader-${randomUUID()}`;
      yield* Effect.scoped(openRegistry);
      expect(yield* fs.exists(registryFile)).toBe(true);

      yield* openDatabase(registryFile, (peer) => {
        peer.exec("PRAGMA busy_timeout = 2000");
        peer.exec("BEGIN EXCLUSIVE");
      });
      const registry = yield* openRegistry;

      expect(yield* registry.find("/reader", stackId, "api")).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
