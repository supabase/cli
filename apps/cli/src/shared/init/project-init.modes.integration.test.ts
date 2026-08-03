import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { mockOutput, mockStdin, mockTty } from "../../../tests/helpers/mocks.ts";
import { initProject } from "./project-init.ts";

function makeTempProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-init-modes-"));
}

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
    const cwd = makeTempProjectDir();
    const prevUmask = process.umask(0);

    return runInit(cwd).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const supabaseDir = join(cwd, "supabase");
          const configTomlPath = join(supabaseDir, "config.toml");

          expect(statSync(supabaseDir).mode & 0o777).toBe(0o755);
          expect(statSync(configTomlPath).mode & 0o777).toBe(0o644);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          process.umask(prevUmask);
          rmSync(cwd, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live(
    "pins a freshly created supabase/.gitignore to Go's exact file mode inside a git repo",
    () => {
      const cwd = makeTempProjectDir();
      mkdirSync(join(cwd, ".git"));
      const prevUmask = process.umask(0);

      return runInit(cwd).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const gitignorePath = join(cwd, "supabase", ".gitignore");
            expect(statSync(gitignorePath).mode & 0o777).toBe(0o644);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            process.umask(prevUmask);
            rmSync(cwd, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});
