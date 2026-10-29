import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";

import {
  InvalidServiceVersionTagError,
  readServiceVersionOverrides,
} from "./service-version-overrides.ts";

const readPins = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* readServiceVersionOverrides(fs, path, workdir, 17);
  });

const makeWorkdir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "service-pins-" }),
);

const writePin = Effect.fnUntraced(function* (workdir: string, fileName: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = path.join(workdir, "supabase", ".temp");
  yield* fs.makeDirectory(tempDir, { recursive: true });
  yield* fs.writeFileString(path.join(tempDir, fileName), contents);
});

describe("readServiceVersionOverrides", () => {
  it.effect("keeps a usable storage pin, including a suffix", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      yield* writePin(workdir, "storage-version", "v1.77.1-versions\n");
      expect(yield* readPins(workdir)).toEqual({ storage: "v1.77.1-versions" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails on a doubled-v storage pin without rewriting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* makeWorkdir;
      const pinPath = path.join(workdir, "supabase", ".temp", "storage-version");
      yield* writePin(workdir, "storage-version", "vv1.77.1-versions\n");
      const error = yield* readPins(workdir).pipe(Effect.flip);
      expect(error).toEqual(
        new InvalidServiceVersionTagError({
          message:
            'invalid storage image tag "vv1.77.1-versions" in supabase/.temp/storage-version; run supabase link again',
        }),
      );
      expect(yield* fs.readFileString(pinPath)).toBe("vv1.77.1-versions\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails on a doubled-v postgrest pin", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      yield* writePin(workdir, "rest-version", "vv12.2.0");
      const error = yield* readPins(workdir).pipe(Effect.flip);
      expect(error).toEqual(
        new InvalidServiceVersionTagError({
          message:
            'invalid postgrest image tag "vv12.2.0" in supabase/.temp/rest-version; run supabase link again',
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when a pin is not a docker tag", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir;
      yield* writePin(workdir, "storage-version", "v1.77.1 bad");
      const exit = yield* readPins(workdir).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
