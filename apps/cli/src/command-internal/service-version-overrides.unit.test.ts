import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
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
  }).pipe(Effect.provide(BunServices.layer));

function writePin(workdir: string, fileName: string, contents: string) {
  const tempDir = join(workdir, "supabase", ".temp");
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, fileName), contents);
}

describe("readServiceVersionOverrides", () => {
  it.effect("keeps a usable storage pin, including a suffix", () =>
    Effect.gen(function* () {
      const workdir = mkdtempSync(join(tmpdir(), "service-pins-"));
      try {
        writePin(workdir, "storage-version", "v1.77.1-versions\n");
        expect(yield* readPins(workdir)).toEqual({ storage: "v1.77.1-versions" });
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("fails on a doubled-v storage pin without rewriting it", () =>
    Effect.gen(function* () {
      const workdir = mkdtempSync(join(tmpdir(), "service-pins-"));
      const pinPath = join(workdir, "supabase", ".temp", "storage-version");
      try {
        writePin(workdir, "storage-version", "vv1.77.1-versions\n");
        const exit = yield* readPins(workdir).pipe(Effect.exit);
        expect(exit).toEqual(
          Exit.fail(
            new InvalidServiceVersionTagError({
              message:
                'invalid storage image tag "vv1.77.1-versions" in supabase/.temp/storage-version; run supabase link again',
            }),
          ),
        );
        expect(readFileSync(pinPath, "utf8")).toBe("vv1.77.1-versions\n");
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("fails on a doubled-v postgrest pin", () =>
    Effect.gen(function* () {
      const workdir = mkdtempSync(join(tmpdir(), "service-pins-"));
      try {
        writePin(workdir, "rest-version", "vv12.2.0");
        const exit = yield* readPins(workdir).pipe(Effect.exit);
        expect(exit).toEqual(
          Exit.fail(
            new InvalidServiceVersionTagError({
              message:
                'invalid postgrest image tag "vv12.2.0" in supabase/.temp/rest-version; run supabase link again',
            }),
          ),
        );
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("fails when a pin is not a docker tag", () =>
    Effect.gen(function* () {
      const workdir = mkdtempSync(join(tmpdir(), "service-pins-"));
      try {
        writePin(workdir, "storage-version", "v1.77.1 bad");
        const exit = yield* readPins(workdir).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    }),
  );
});
