import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { mockOutput, mockStdin, mockTty } from "../../../tests/helpers/mocks.ts";
import { initProject } from "./project-init.ts";

function runInit(cwd: string) {
  const out = mockOutput({ format: "text", interactive: false });
  // `initProject`'s type requires `Stdin` (the IDE-settings prompt path threads
  // through it), even though `interactive: false` below means it's never read.
  const layer = Layer.mergeAll(out.layer, mockTty(), mockStdin(false), BunServices.layer);
  return initProject({
    cwd,
    force: false,
    useOrioledb: false,
    interactive: false,
    yes: false,
    withVscodeSettings: false,
    withIntellijSettings: false,
  }).pipe(Effect.provide(layer));
}

// Go pins every init-scaffolded directory to 0755 and file to 0644
// (`internal/init/init.go:89,121,138,151,166` via `utils.WriteFile`/
// `MkdirIfNotExistFS`, `internal/utils/misc.go:273,281-284`). Node's own
// umask-masked defaults happen to coincide under the common `022`, so pin the
// process umask to 0 here to prove the modes are pinned explicitly, not
// incidental to the ambient umask.
describe("initProject file modes (Go parity: 0755 dirs, 0644 files)", () => {
  it.live("pins the supabase dir and config.toml to Go's exact modes", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectory({ prefix: "supabase-init-modes-" });
      const prevUmask = process.umask(0);
      yield* Effect.gen(function* () {
        yield* runInit(cwd);
        const supabaseDir = path.join(cwd, "supabase");
        const configTomlPath = path.join(supabaseDir, "config.toml");

        expect((yield* fs.stat(supabaseDir)).mode & 0o777).toBe(0o755);
        expect((yield* fs.stat(configTomlPath)).mode & 0o777).toBe(0o644);
      }).pipe(
        Effect.ensuring(Effect.sync(() => process.umask(prevUmask))),
        Effect.ensuring(fs.remove(cwd, { recursive: true }).pipe(Effect.ignore)),
      );
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live(
    "pins a freshly created supabase/.gitignore to Go's exact file mode inside a git repo",
    () => {
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectory({ prefix: "supabase-init-modes-" });
        const prevUmask = process.umask(0);
        yield* Effect.gen(function* () {
          yield* fs.makeDirectory(path.join(cwd, ".git"));
          yield* runInit(cwd);
          const gitignorePath = path.join(cwd, "supabase", ".gitignore");
          expect((yield* fs.stat(gitignorePath)).mode & 0o777).toBe(0o644);
        }).pipe(
          Effect.ensuring(Effect.sync(() => process.umask(prevUmask))),
          Effect.ensuring(fs.remove(cwd, { recursive: true }).pipe(Effect.ignore)),
        );
      }).pipe(Effect.provide(BunServices.layer));
    },
  );
});
