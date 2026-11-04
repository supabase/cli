import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { encodeEntry, segmentName } from "./LogRecord.ts";
import { streamStackLogs } from "./LogStore.ts";

const line = (text: string) =>
  encodeEntry({ kind: "stdout", timestamp: 0, launchId: 1, text, truncated: false });

it.effect(
  "pins segment lengths and generations before reading and resumes completed partial records",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "logs-snapshot-" });
      const directory = path.join(root, "auth", "one");
      const file = path.join(directory, segmentName(1));
      yield* fs.makeDirectory(directory, { recursive: true });
      const partial = line("partial").slice(0, -1);
      yield* fs.writeFileString(file, line("first") + partial);
      let changed = false;
      const changingFs: FileSystem.FileSystem = {
        ...fs,
        open: (target, options) =>
          Effect.gen(function* () {
            if (target === file && !changed) {
              changed = true;
              yield* fs.writeFileString(file, "\n" + line("later"), { flag: "a" });
              yield* fs.writeFileString(path.join(directory, segmentName(2)), line("rotated"));
            }
            return yield* fs.open(target, options);
          }),
      };
      const first = yield* streamStackLogs({ root, snapshot: true }).pipe(
        Stream.runCollect,
        Effect.provideService(FileSystem.FileSystem, changingFs),
      );
      expect(changed).toBe(true);
      expect(first.map(({ text }) => text)).toEqual(["first"]);
      const position = first[0]?.position;
      expect(position).toBeDefined();
      const resumed = yield* streamStackLogs({
        root,
        snapshot: true,
        from: position === undefined ? new Map() : new Map([["one", position]]),
      }).pipe(Stream.runCollect);
      expect(resumed.map(({ text }) => text)).toEqual(["first", "partial", "later", "rotated"]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("captures every selected instance before consumption begins", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "logs-snapshot-instances-" });
    for (const id of ["one", "two"]) {
      const directory = path.join(root, "auth", id);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, segmentName(1)), line(id));
    }
    let appended = false;
    const rows = yield* streamStackLogs({ root, snapshot: true }).pipe(
      Stream.tap(() =>
        Effect.gen(function* () {
          if (appended) return;
          appended = true;
          for (const id of ["one", "two"])
            yield* fs.writeFileString(path.join(root, "auth", id, segmentName(1)), line("new"), {
              flag: "a",
            });
        }),
      ),
      Stream.runCollect,
    );
    expect(
      rows.map(({ text }) => text).toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["one", "two"]);
    expect((yield* streamStackLogs({ root, snapshot: true }).pipe(Stream.runCollect)).length).toBe(
      4,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a lost marker when the resume generation has been removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "logs-snapshot-gap-" });
    const directory = path.join(root, "auth", "one");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(path.join(directory, segmentName(1)), line("old"));
    yield* fs.writeFileString(path.join(directory, segmentName(3)), line("retained"));
    const rows = yield* streamStackLogs({
      root,
      snapshot: true,
      from: new Map([["one", { generation: 2, byteOffset: 10 }]]),
    }).pipe(Stream.runCollect);
    expect(rows.map(({ kind }) => kind)).toEqual(["lost", "stdout"]);
    expect(rows[0]?.resumeAt).toEqual({ generation: 3, byteOffset: 0 });
    expect(rows[1]?.text).toBe("retained");
  }).pipe(Effect.provide(NodeServices.layer)),
);
