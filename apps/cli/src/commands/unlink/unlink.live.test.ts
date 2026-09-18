import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../tests/helpers/live.ts";

// Golden path only: a real `link`'s workspace state must round-trip through
// unlink, leaving no local link state. Error paths live in unlink.e2e.test.ts
// and unlink.integration.test.ts.
test("unlinks a linked workspace, leaving no local link state", ({
  cliEffect,
  project,
  signal,
  workspace,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const linked = yield* cliEffect(["link", "--project-ref", project.ref, "--skip-pooler"]);
      requireLiveSuccess(linked, "link setup for unlink");
      const cache = path.join(workspace.path, "supabase", ".temp", "linked-project.json");
      const cacheExists = yield* fs.exists(cache);
      expect(cacheExists, linked.stderr).toBe(true);

      const result = yield* cliEffect(["unlink"]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("Finished supabase unlink.");
      expect(result.stderr).toContain(`Unlinking project: ${project.ref}`);
      const tempDirExists = yield* fs.exists(path.join(workspace.path, "supabase", ".temp"));
      expect(tempDirExists, result.stderr).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
    { signal },
  ));
