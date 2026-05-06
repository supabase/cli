import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, Layer, Option } from "effect";
import { mockProcessControl } from "../../../tests/helpers/mocks.ts";
import { Output } from "./output.service.ts";
import { withJsonErrorHandling } from "./json-error-handling.ts";

// ---------------------------------------------------------------------------
// Test error types
// ---------------------------------------------------------------------------

class TaggedErrorWithDetail extends Data.TaggedError("TaggedErrorWithDetail")<{
  readonly message: string;
  readonly detail: string;
  readonly suggestion: string;
}> {}

class TaggedErrorMinimal extends Data.TaggedError("TaggedErrorMinimal")<{
  readonly message: string;
}> {}

class PlainError {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

// ---------------------------------------------------------------------------
// Mock output factory
// ---------------------------------------------------------------------------

type FailCall = {
  code: string;
  message: string;
  detail?: string;
  suggestion?: string;
};

function mockOutput(format: "text" | "json" | "stream-json" = "text") {
  const failCalls: FailCall[] = [];
  return {
    layer: Layer.succeed(Output, {
      format,
      interactive: format === "text",
      intro: (_message: string) => Effect.void,
      outro: (_message: string) => Effect.void,
      info: (_message: string) => Effect.void,
      warn: (_message: string) => Effect.void,
      error: (_message: string) => Effect.void,
      event: (_event) => Effect.void,
      task: (_message: string) =>
        Effect.succeed({
          message: (_nextMessage: string) => Effect.void,
          succeed: (_nextMessage?: string) => Effect.void,
          fail: (_nextMessage?: string) => Effect.void,
          info: (_nextMessage?: string) => Effect.void,
          cancel: (_nextMessage?: string) => Effect.void,
          clear: () => Effect.void,
        }),
      success: (_message: string, _data?: Record<string, unknown>) => Effect.void,
      fail: (err: FailCall) =>
        Effect.sync(() => {
          failCalls.push(err);
        }),
      progress: (_opts: { max: number }) =>
        Effect.sync(() => ({
          start: (_msg: string) => Effect.void,
          advance: (_step: number, _msg?: string) => Effect.void,
          message: (_msg: string) => Effect.void,
          stop: (_msg: string) => Effect.void,
        })),
      promptText: () => Effect.succeed(""),
      promptPassword: () => Effect.succeed(""),
      promptConfirm: () => Effect.succeed(true),
      promptSelect: (_message, options) => Effect.succeed(options[0]!.value),
      promptMultiSelect: (_message, options) =>
        Effect.succeed(options.map((option) => option.value)),
    }),
    get failCalls() {
      return failCalls;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withJsonErrorHandling", () => {
  describe("text format", () => {
    it.live("re-raises the original error in text format", () => {
      const processControl = mockProcessControl();
      return Effect.gen(function* () {
        const out = mockOutput("text");
        const error = new TaggedErrorWithDetail({
          message: "something went wrong",
          detail: "some detail",
          suggestion: "try again",
        });
        const failingEffect = Effect.fail(error);
        const exit = yield* withJsonErrorHandling(failingEffect).pipe(
          Effect.exit,
          Effect.provide(out.layer),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const errorOption = Exit.findErrorOption(exit);
        expect(Option.isSome(errorOption)).toBe(true);
        if (Option.isSome(errorOption)) {
          expect(errorOption.value).toBe(error);
        }
        expect(out.failCalls).toHaveLength(0);
      }).pipe(Effect.provide(processControl.layer));
    });
  });

  describe("json format", () => {
    it.live("calls output.fail() with structured error and sets process.exitCode", () => {
      const out = mockOutput("json");
      const processControl = mockProcessControl();
      return Effect.gen(function* () {
        const error = new TaggedErrorWithDetail({
          message: "something went wrong",
          detail: "some detail",
          suggestion: "try again",
        });
        const failingEffect = Effect.fail(error);
        yield* withJsonErrorHandling(failingEffect).pipe(Effect.provide(out.layer));
        expect(out.failCalls).toHaveLength(1);
        expect(out.failCalls[0]).toEqual({
          code: "TaggedErrorWithDetail",
          message: "something went wrong",
          detail: "some detail",
          suggestion: "try again",
        });
        expect(processControl.exitCode).toBe(1);
      }).pipe(Effect.provide(out.layer), Effect.provide(processControl.layer));
    });

    it.live("includes detail and suggestion when present on error", () => {
      const out = mockOutput("json");
      const processControl = mockProcessControl();
      return Effect.gen(function* () {
        const error = new TaggedErrorWithDetail({
          message: "detailed error",
          detail: "in-depth explanation",
          suggestion: "do this instead",
        });
        yield* withJsonErrorHandling(Effect.fail(error)).pipe(Effect.provide(out.layer));
        expect(out.failCalls[0]).toMatchObject({
          detail: "in-depth explanation",
          suggestion: "do this instead",
        });
      }).pipe(Effect.provide(out.layer), Effect.provide(processControl.layer));
    });

    it.live("omits detail and suggestion when absent on error", () => {
      const out = mockOutput("json");
      const processControl = mockProcessControl();
      return Effect.gen(function* () {
        const error = new TaggedErrorMinimal({ message: "minimal error" });
        yield* withJsonErrorHandling(Effect.fail(error)).pipe(Effect.provide(out.layer));
        expect(out.failCalls).toHaveLength(1);
        const call = out.failCalls[0]!;
        expect(call.code).toBe("TaggedErrorMinimal");
        expect(call.message).toBe("minimal error");
        expect("detail" in call).toBe(false);
        expect("suggestion" in call).toBe(false);
      }).pipe(Effect.provide(out.layer), Effect.provide(processControl.layer));
    });

    it.live("uses UnknownError code when error has no _tag", () => {
      const out = mockOutput("json");
      const processControl = mockProcessControl();
      return Effect.gen(function* () {
        const error = new PlainError("plain error message");
        yield* withJsonErrorHandling(Effect.fail(error)).pipe(Effect.provide(out.layer));
        expect(out.failCalls).toHaveLength(1);
        expect(out.failCalls[0]?.code).toBe("UnknownError");
        expect(out.failCalls[0]?.message).toBe("plain error message");
      }).pipe(Effect.provide(out.layer), Effect.provide(processControl.layer));
    });
  });
});
