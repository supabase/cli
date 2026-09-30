import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { mockOutput, mockStdin, mockTty } from "../../../tests/helpers/mocks.ts";
import { initProject } from "./project-init.ts";

const makeTempProjectDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "supabase-init-modes-" }),
);

// Pin the process umask to 0 to prove the modes below are pinned explicitly,
// not incidental to Node's own umask-masked defaults (which coincide under
// the common 022).
const zeroUmask = Effect.acquireRelease(
  Effect.sync(() => process.umask(0)),
  (prevUmask) => Effect.sync(() => process.umask(prevUmask)),
);

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

const fileMode = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.stat(pathname)).mode & 0o777;
});

describe("initProject file modes (Go parity: 0755 dirs, 0644 files)", () => {
  it.live("pins the supabase dir and config.toml to Go's exact modes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwd = yield* makeTempProjectDir;
      yield* zeroUmask;

      yield* runInit(cwd);

      const supabaseDir = path.join(cwd, "supabase");
      expect(yield* fileMode(supabaseDir)).toBe(0o755);
      expect(yield* fileMode(path.join(supabaseDir, "config.toml"))).toBe(0o644);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "pins a freshly created supabase/.gitignore to Go's exact file mode inside a git repo",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempProjectDir;
        yield* fs.makeDirectory(path.join(cwd, ".git"));
        yield* zeroUmask;

        yield* runInit(cwd);

        expect(yield* fileMode(path.join(cwd, "supabase", ".gitignore"))).toBe(0o644);
      }).pipe(Effect.provide(BunServices.layer)),
  );
});
