import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { encodeEntry, segmentName } from "./LogRecord.ts";
import { streamStackLogs } from "./LogStore.ts";

const line = (text: string, timestamp = 0) =>
  encodeEntry({ kind: "stdout", timestamp, launchId: 1, text, truncated: false });

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
      yield* fs.writeFileString(file, line("first") + line("second") + partial);
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
      const first = yield* streamStackLogs({ root }).pipe(
        Stream.runCollect,
        Effect.provideService(FileSystem.FileSystem, changingFs),
      );
      expect(changed).toBe(true);
      expect(first.map(({ text }) => text)).toEqual(["first", "second"]);
      const position = first[1]?.position;
      expect(position?.byteOffset).toBeGreaterThan(0);
      const resumed = yield* streamStackLogs({
        root,
        from: position === undefined ? new Map() : new Map([["one", position]]),
      }).pipe(Stream.runCollect);
      expect(resumed.map(({ text }) => text)).toEqual(["second", "partial", "later", "rotated"]);
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
    const rows = yield* streamStackLogs({ root }).pipe(
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
    expect((yield* streamStackLogs({ root }).pipe(Stream.runCollect)).length).toBe(4);
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
      from: new Map([["one", { generation: 2, byteOffset: 10 }]]),
    }).pipe(Stream.runCollect);
    expect(rows.map(({ kind }) => kind)).toEqual(["lost", "stdout"]);
    expect(rows[0]?.resumeAt).toEqual({ generation: 3, byteOffset: 0 });
    expect(rows[1]?.text).toBe("retained");
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const scenario of [
  {
    name: "timestamps a deleted middle segment at the next retained record",
    count: 3,
    deleted: [2],
    retained: 3,
  },
  {
    name: "timestamps consecutive deleted segments at the next retained record",
    count: 4,
    deleted: [2, 3],
    retained: 4,
  },
  {
    name: "finishes when the final captured segments disappear",
    count: 3,
    deleted: [2, 3],
    retained: undefined,
  },
])
  it.effect(scenario.name, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "logs-snapshot-deleted-" });
      const directory = path.join(root, "auth", "one");
      yield* fs.makeDirectory(directory, { recursive: true });
      for (let generation = 1; generation <= scenario.count; generation++)
        yield* fs.writeFileString(
          path.join(directory, segmentName(generation)),
          line(generation === 1 ? "first" : "retained", generation * 1000),
        );
      let deleted = false;
      const deletingFs: FileSystem.FileSystem = {
        ...fs,
        open: (target, options) =>
          Effect.gen(function* () {
            if (target === path.join(directory, segmentName(1)) && !deleted) {
              deleted = true;
              for (const generation of scenario.deleted)
                yield* fs.remove(path.join(directory, segmentName(generation)));
            }
            return yield* fs.open(target, options);
          }),
      };
      const rows = yield* streamStackLogs({ root }).pipe(
        Stream.runCollect,
        Effect.provideService(FileSystem.FileSystem, deletingFs),
      );
      expect(deleted).toBe(true);
      const expected = [{ kind: "stdout", text: "first", timestamp: "1970-01-01T00:00:01.000Z" }];
      if (scenario.retained !== undefined) {
        const timestamp =
          scenario.retained === 3 ? "1970-01-01T00:00:03.000Z" : "1970-01-01T00:00:04.000Z";
        expect(
          rows.slice(1).map(({ kind, text, timestamp }) => ({ kind, text, timestamp })),
        ).toEqual([
          { kind: "lost", text: undefined, timestamp },
          { kind: "stdout", text: "retained", timestamp },
        ]);
        expect(rows[1]?.resumeAt).toEqual({ generation: scenario.retained, byteOffset: 0 });
      }
      expect(
        rows.slice(0, 1).map(({ kind, text, timestamp }) => ({ kind, text, timestamp })),
      ).toEqual(expected);
      expect(rows).toHaveLength(scenario.retained === undefined ? 1 : 3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
