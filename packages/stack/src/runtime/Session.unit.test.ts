import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, PubSub } from "effect";
import { launchOutputPublisher, mapToServiceError, type LaunchOutput } from "./Session.ts";

describe("mapToServiceError", () => {
  it("names an error whose cause carries no message", () => {
    const failure = mapToServiceError("stop", new Cause.UnknownError(undefined));

    expect(failure.message).toBe("UnknownError");
  });

  it("describes a wrapped error without a message by its cause", () => {
    const cause = new Cause.UnknownError(new Error("container is gone"));
    const failure = mapToServiceError("stop", cause);

    expect(failure.message).toBe("container is gone");
  });
});

describe("launchOutputPublisher", () => {
  it.effect(
    "tags chunks with the launch, a part per process and a launch-wide sequence per stream",
    () =>
      Effect.gen(function* () {
        const logs = yield* PubSub.unbounded<LaunchOutput>();
        const subscription = yield* PubSub.subscribe(logs);
        const output = yield* launchOutputPublisher(logs, 7);
        const startup = yield* output.part;
        const main = yield* output.part;
        const bytes = new Uint8Array([0x61]);

        yield* startup("stdout", bytes);
        yield* startup("stderr", bytes);
        yield* startup("stdout", bytes);
        yield* main("stdout", bytes);
        const published = yield* PubSub.takeAll(subscription);

        expect(
          published.map(({ stream, launchId, part, seq }) => ({ stream, launchId, part, seq })),
        ).toEqual([
          { stream: "stdout", launchId: 7, part: 0, seq: 0 },
          { stream: "stderr", launchId: 7, part: 0, seq: 0 },
          { stream: "stdout", launchId: 7, part: 0, seq: 1 },
          { stream: "stdout", launchId: 7, part: 1, seq: 2 },
        ]);
      }).pipe(Effect.scoped),
  );
});
