import { NodeServices, NodeSocketServer } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as State from "../src/State.ts";
import { isBunVirtualPath } from "../src/internal/dispatch-markers.ts";
import { fileURLToPath } from "node:url";

const [mode, root, id] = process.argv.slice(2);
if (root === undefined) throw new Error("Registry root missing");

const program = Effect.scoped(
  Effect.gen(function* () {
    if (mode === "child") {
      yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 });
      yield* Console.log(`child:${process.pid}`);
      return yield* Effect.never;
    }
    yield* Effect.gen(function* () {
      const state = yield* State.Service;
      yield* state.withLock(
        Effect.gen(function* () {
          if (mode === "write") {
            const saved = yield* state.read("stack-main");
            if (saved === undefined || id === undefined)
              return yield* Effect.die("Missing writer state");
            yield* state.save({
              ...saved,
              instances: [...saved.instances, { id, creation: {} }],
            });
            return;
          }
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                ...(isBunVirtualPath(import.meta.url) ? [] : [fileURLToPath(import.meta.url)]),
                "child",
                root,
              ],
              {
                detached: false,
                stdin: "ignore",
                stdout: "inherit",
                stderr: "inherit",
                forceKillAfter: "1 second",
              },
            ),
          );
          yield* Console.log("locked");
          return yield* Effect.never;
        }),
      );
    }).pipe(Effect.provide(State.layer({ root })));
  }),
).pipe(Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
