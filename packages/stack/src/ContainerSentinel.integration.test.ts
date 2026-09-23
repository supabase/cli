import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Option, Path, Stream } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The fake container engine must be executable by the detached sentinel.
import { chmodSync, existsSync, watch } from "node:fs";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { NodeServices } from "@effect/platform-node";
import * as ContainerSentinel from "./ContainerSentinel.ts";

it.live.skipIf(process.platform === "win32")(
  "reconciles stack-owned containers and verifies generation-scoped shutdown cleanup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "container-sentinel-" });
        const statePath = path.join(directory, "containers");
        const enginePath = path.join(directory, "fake-engine");
        yield* fs.writeFileString(
          statePath,
          "old-stack|stack-a|old-generation\nparallel|stack-b|other-generation\n",
        );
        const engine =
          `#!${process.execPath}\nimport { readFileSync, writeFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nconst [command, ...args] = process.argv.slice(2);\nconst state = fileURLToPath(new URL("./containers", import.meta.url));\nconst rows = readFileSync(state, "utf8").split("\\n").filter(Boolean).map((line) => line.split("|"));\nif (command === "ps") { const filters = args.flatMap((arg, i) => arg === "--filter" ? [args[i + 1]] : []); const found = rows.filter(([id, stack, generation]) => filters.every((filter) => filter === ` +
          "`label=com.supabase.stack=${stack}`" +
          ` || filter === ` +
          "`label=com.supabase.host-generation=${generation}`" +
          ` || filter === ` +
          "`id=${id}`" +
          `)).map(([id]) => id); console.log(found.join("\\n")); process.exit(0); }\nif (command === "rm") { const id = args.at(-1); const next = rows.filter(([rowId]) => rowId !== id); writeFileSync(state, next.map((row) => row.join("|")).join("\\n") + (next.length ? "\\n" : "")); if (id === "first") writeFileSync(fileURLToPath(new URL("./first-sweep", import.meta.url)), "done"); process.exit(0); }\nprocess.exit(2);\n`;
        yield* fs.writeFileString(enginePath, engine, { mode: 0o700 });
        yield* Effect.sync(() => chmodSync(enginePath, 0o700));
        const sentinel = yield* ContainerSentinel.start({
          directory,
          stackId: "stack-a",
          engine: enginePath,
        });
        if (sentinel === undefined) return yield* Effect.die("Unix sentinel was not started");
        const afterStartup = yield* fs.readFileString(statePath);
        expect(afterStartup).toBe("parallel|stack-b|other-generation\n");

        const currentGeneration = sentinel.owner.generation;
        const stateAfterStartup = yield* fs.readFileString(statePath);
        yield* fs.writeFileString(
          statePath,
          `${stateAfterStartup}current|stack-a|${currentGeneration}\nother-generation|stack-a|other\n`,
        );
        yield* ContainerSentinel.removeOwned({
          engine: enginePath,
          stackId: "stack-a",
          generation: currentGeneration,
        });
        const afterOwnedRemoval = yield* fs.readFileString(statePath);
        expect(afterOwnedRemoval).toContain("parallel|stack-b|other-generation");
        expect(afterOwnedRemoval).toContain("other-generation|stack-a|other");
        expect(afterOwnedRemoval).not.toContain(`current|stack-a|${currentGeneration}`);

        yield* fs.writeFileString(
          statePath,
          `${afterOwnedRemoval}first|stack-a|${currentGeneration}\n`,
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const lease = yield* spawner.spawn(
          ChildProcess.make(
            "/bin/sh",
            [
              "-c",
              ContainerSentinel.mutationLeaseScript,
              "sentinel-mutation-lease",
              sentinel.owner.mutationFifoPath,
              "/bin/sh",
              "-c",
              'printf "lease-ready\\n"; while IFS= read -r line; do :; done',
            ],
            { stdin: "pipe" },
          ),
        );
        const leaseReady = yield* lease.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.die("Mutation lease did not become ready"),
              onSome: Effect.succeed,
            }),
          ),
        );
        expect(leaseReady).toBe("lease-ready");
        const firstSweep = yield* waitForFile(directory, "first-sweep").pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const closing = yield* sentinel.close.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(firstSweep);
        const afterFirstSweep = yield* fs.readFileString(statePath);
        expect(afterFirstSweep).not.toContain(`first|stack-a|${currentGeneration}`);
        yield* fs.writeFileString(
          statePath,
          `${afterFirstSweep}late|stack-a|${currentGeneration}\n`,
        );
        yield* lease.kill({ killSignal: "SIGTERM" });
        yield* lease.exitCode.pipe(Effect.ignore);
        yield* Fiber.join(closing);
        const afterOwnerLoss = yield* fs.readFileString(statePath);
        expect(afterOwnerLoss).toContain("parallel|stack-b|other-generation");
        expect(afterOwnerLoss).toContain("other-generation|stack-a|other");
        expect(afterOwnerLoss).not.toContain(`late|stack-a|${currentGeneration}`);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.live.skipIf(process.platform === "win32")(
  "opens a mutation lease without a sentinel reader",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mutation-no-reader-" });
        const fifoPath = path.join(directory, "orphan.fifo");
        const markerPath = path.join(directory, "complete");
        const fifo = yield* spawner.spawn(
          ChildProcess.make("mkfifo", [fifoPath], { stdin: "ignore" }),
        );
        expect(Number(yield* fifo.exitCode)).toBe(0);
        const mutation = yield* spawner.spawn(
          ChildProcess.make(
            "/bin/sh",
            [
              "-c",
              ContainerSentinel.mutationLeaseScript,
              "sentinel-mutation-lease",
              fifoPath,
              "/usr/bin/touch",
              markerPath,
            ],
            { stdin: "ignore", detached: true },
          ),
        );
        expect(Number(yield* mutation.exitCode.pipe(Effect.timeout("2 seconds")))).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.live.skipIf(process.platform === "win32")(
  "removes an empty stack root after destroy removed state before sentinel shutdown",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "sentinel-destroy-root-" });
        const stackRoot = path.join(root, "stack");
        yield* fs.makeDirectory(stackRoot);
        const sentinel = yield* ContainerSentinel.start({
          directory: stackRoot,
          stackId: "destroy-root",
          engine: "/usr/bin/true",
        });
        if (sentinel === undefined) return yield* Effect.die("Unix sentinel was not started");

        yield* fs.makeDirectory(path.join(stackRoot, "data"));
        yield* fs.remove(path.join(stackRoot, "state.json"), { force: true });
        yield* fs.remove(path.join(stackRoot, "data"), { recursive: true, force: true });
        expect(yield* fs.exists(stackRoot)).toBe(true);

        yield* sentinel.close;
        expect(yield* fs.exists(stackRoot)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

const waitForFile = (directory: string, name: string) =>
  Effect.callback<void, never>((resume) => {
    const finish = () => {
      if (existsSync(`${directory}/${name}`)) resume(Effect.void);
    };
    const watcher = watch(directory, (_event, filename) => {
      if (filename?.toString() === name) finish();
    });
    finish();
    return Effect.sync(() => watcher.close());
  });
