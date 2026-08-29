import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { services } from "./services.handler.ts";
import { CommandRuntime } from "../../../shared/runtime/command-runtime.service.ts";
import {
  emptyEnv,
  mockCredentials,
  mockOutput,
  mockProjectLinkState,
  mockCliProjectLocalServiceVersions,
} from "../../../../tests/helpers/mocks.ts";

describe("services handler", () => {
  it.live("renders the local service image matrix when unlinked", () => {
    const out = mockOutput({ interactive: false });
    const layer = Layer.mergeAll(
      emptyEnv(),
      out.layer,
      mockCredentials().layer,
      mockProjectLinkState(),
      mockCliProjectLocalServiceVersions(),
      FetchHttpClient.layer,
      Layer.succeed(CommandRuntime, { commandPath: ["services"], commandRunId: "test" }),
    );
    return services().pipe(
      Effect.provide(layer),
      Effect.tap(() =>
        Effect.sync(() =>
          expect(out.rawChunks.some((chunk) => chunk.text.includes("postgres"))).toBe(true),
        ),
      ),
    );
  });
});
