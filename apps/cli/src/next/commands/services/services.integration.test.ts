import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/unstable/http";
import { Effect, Layer } from "effect";
import { services } from "./services.handler.ts";
import { CommandRuntime } from "../../../shared/runtime/command-runtime.service.ts";
import {
  mockCredentials,
  mockOutput,
  mockProjectLinkState,
  mockProjectLocalServiceVersions,
} from "../../../../tests/helpers/mocks.ts";
import { makeRunningStackFixture } from "../../../../tests/helpers/running-stack.ts";

describe("services handler", () => {
  it.live(
    "uses pinned versions from the managed launch document",
    () =>
      Effect.scoped(
        Effect.promise(() => makeRunningStackFixture()).pipe(
          Effect.flatMap((fixture) => {
            const out = mockOutput();
            const layer = Layer.mergeAll(
              fixture.baseLayer,
              out.layer,
              mockProjectLinkState(),
              mockProjectLocalServiceVersions(),
              mockCredentials().layer,
              Layer.succeed(CommandRuntime, {
                commandPath: ["stack", "services"],
                commandRunId: "test-run",
              }),
              BunServices.layer,
              FetchHttpClient.layer,
            );
            return services().pipe(
              Effect.provide(layer),
              Effect.ensuring(Effect.promise(() => fixture.dispose())),
              Effect.andThen(
                Effect.sync(() => {
                  expect(out.rawChunks.some((chunk) => chunk.text.includes("postgres"))).toBe(true);
                }),
              ),
            );
          }),
        ),
      ),
    30_000,
  );
});
