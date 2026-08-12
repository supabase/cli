import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { useLegacyTempWorkdir } from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyWalkSqlFiles } from "../../../shared/legacy-glob.ts";
import { LegacyLoadPgDeltaSqlFiles } from "./legacy-pgdelta-files.ts";

const load = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* LegacyLoadPgDeltaSqlFiles(fs, path, directory);
  }).pipe(Effect.provide(BunServices.layer));

describe("LegacyLoadPgDeltaSqlFiles", () => {
  const tmp = useLegacyTempWorkdir("legacy-pgdelta-files-");

  it.effect("does not follow symlinked directories", () => {
    const schemas = join(tmp.current, "schemas");
    const outside = join(tmp.current, "outside");
    mkdirSync(schemas);
    mkdirSync(outside);
    writeFileSync(join(schemas, "kept.sql"), "select 'kept';");
    writeFileSync(join(outside, "hidden.sql"), "select 'hidden';");
    symlinkSync(outside, join(schemas, "linked"), "dir");

    return Effect.gen(function* () {
      const files = yield* load(schemas);
      expect(files).toEqual([{ name: "kept.sql", sql: "select 'kept';" }]);
    });
  });

  it.effect("ignores uppercase .SQL files", () => {
    const schemas = join(tmp.current, "schemas");
    mkdirSync(schemas);
    writeFileSync(join(schemas, "included.sql"), "select 1;");
    writeFileSync(join(schemas, "ignored.SQL"), "select 2;");

    return Effect.gen(function* () {
      const files = yield* load(schemas);
      expect(files).toEqual([{ name: "included.sql", sql: "select 1;" }]);
    });
  });

  it.effect("preserves the shared walker's deterministic UTF-8 byte ordering", () => {
    const schemas = join(tmp.current, "schemas");
    const privateUse = "a\u{e000}.sql";
    const supplementary = "a\u{1f600}.sql";
    mkdirSync(schemas);
    writeFileSync(join(schemas, supplementary), "select 2;");
    writeFileSync(join(schemas, privateUse), "select 1;");

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const walked = yield* legacyWalkSqlFiles(fs, schemas, "");
      const files = yield* LegacyLoadPgDeltaSqlFiles(fs, yield* Path.Path, schemas);
      expect(files.map((file) => file.name)).toEqual(walked);
      expect(files.map((file) => file.name)).toEqual([privateUse, supplementary]);
    }).pipe(Effect.provide(BunServices.layer));
  });
});
