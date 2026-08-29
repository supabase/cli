import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { update } from "./update.handler.ts";
import {
  emptyEnv,
  mockOutput,
  mockProjectLinkRemote,
  mockProjectLinkState,
} from "../../../../tests/helpers/mocks.ts";

describe("update handler", () => {
  it.live("reports stack configuration readiness without a linked project", () => {
    const out = mockOutput({ interactive: false });
    return update({ stack: "default" }).pipe(
      Effect.provide(
        Layer.mergeAll(emptyEnv(), out.layer, mockProjectLinkState(), mockProjectLinkRemote()),
      ),
      Effect.tap(() =>
        Effect.sync(() =>
          expect(out.messages.some((message) => message.type === "success")).toBe(true),
        ),
      ),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => expect(Exit.isSuccess(exit)).toBe(true))),
    );
  });
});
