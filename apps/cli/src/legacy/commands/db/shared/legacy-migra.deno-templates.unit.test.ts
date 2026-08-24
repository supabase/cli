import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { LEGACY_EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL } from "../../../shared/legacy-edge-runtime-script.service.ts";
import {
  legacyMigraDiffScript,
  legacyMigraDiffShellScript,
} from "./legacy-migra.deno-templates.ts";

// Resolve the Go template sources relative to this file so the byte-equality
// assertion fails loudly if the embedded copies drift from upstream.
const goDiffTemplatesDir = fileURLToPath(
  new URL("../../../../../../cli-go/internal/db/diff/templates/", import.meta.url),
);
const readGoTemplate = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(goDiffTemplatesDir, name));
  });

describe("embedded migra templates", () => {
  it.effect("match the Go sources byte-for-byte", () =>
    Effect.gen(function* () {
      expect(legacyMigraDiffScript).toBe(yield* readGoTemplate("migra.ts"));
      expect(legacyMigraDiffShellScript).toBe(yield* readGoTemplate("migra.sh"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it("emit the error sentinel from the diff script's failure path", () => {
    expect(legacyMigraDiffScript).toContain(LEGACY_EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL);
  });
});
