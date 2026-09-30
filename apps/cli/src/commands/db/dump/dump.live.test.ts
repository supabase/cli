import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { expect } from "vitest";

import { test } from "../../../../tests/helpers/live.ts";

test("dumps the remote schema to a file", ({ cliEffect, project, workspace, signal }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outFile = path.join(workspace.path, "schema.sql");
      const result = yield* cliEffect(["db", "dump", "--db-url", project.dbUrl, "-f", outFile]);
      expect(result.exitCode, result.stderr).toBe(0);
      const dump = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        yield* fs.readFile(outFile),
      );
      expect(
        /^CREATE /m.test(dump),
        `stderr:\n${result.stderr}\nfile:\n${dump.slice(0, 1_000)}`,
      ).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
    { signal },
  ));
