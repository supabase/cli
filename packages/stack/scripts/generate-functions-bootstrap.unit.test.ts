import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import {
  generatedModulePath,
  renderFunctionsBootstrapModule,
} from "./generate-functions-bootstrap.ts";

describe("generated Functions bootstrap", () => {
  it.effect(
    "matches a fresh bundle of the main service sources",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const committed = yield* fs.readFileString(yield* generatedModulePath);
        const rendered = yield* renderFunctionsBootstrapModule;
        expect(
          committed === rendered,
          "src/functions/generated/serve-main-bundle.ts is stale; run `pnpm generate` in packages/stack",
        ).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );
});
