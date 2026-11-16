import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import * as PortReservations from "./PortReservations.ts";
import { openDatabase } from "./drivers/Sqlite.ts";

const openRegistry = (directory: string) =>
  Layer.build(PortReservations.layerAt(directory)).pipe(
    Effect.map((context) => Context.get(context, PortReservations.Service)),
  );

it.live("opens and reads the registry while a peer connection holds its write lock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "port-reservations-" });
      const registryFile = path.join(directory, "ports.sqlite");
      const first = yield* openRegistry(directory);
      yield* first.reserve("/peer", "peer", "api", 54321);

      yield* openDatabase(registryFile, (peer) => {
        peer.exec("PRAGMA busy_timeout = 2000");
        peer.exec("BEGIN EXCLUSIVE");
      });
      const second = yield* openRegistry(directory);

      expect(yield* second.find("/peer", "peer", "api")).toBe(54321);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
