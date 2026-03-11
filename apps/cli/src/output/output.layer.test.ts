import { describe, expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vitest";
import { Cause, Effect, Exit, Layer, Sink, Stdio, Stream } from "effect";
import { NonInteractiveError } from "./errors.ts";
import { mockTty } from "../../tests/helpers/mocks.ts";
import { Output } from "./output.service.ts";
import {
  jsonOutputLayer,
  outputLayerFor,
  streamJsonOutputLayer,
  textOutputLayer,
} from "./output.layer.ts";

const mockClack = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn((_v: unknown) => false),
}));

vi.mock("@clack/prompts", () => ({
  intro: (a: unknown) => mockClack.intro(a),
  outro: (a: unknown) => mockClack.outro(a),
  log: mockClack.log,
  text: (a: unknown) => mockClack.text(a),
  password: (a: unknown) => mockClack.password(a),
  confirm: (a: unknown) => mockClack.confirm(a),
  cancel: (a: unknown) => mockClack.cancel(a),
  isCancel: (a: unknown) => mockClack.isCancel(a),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mockClack.isCancel.mockReturnValue(false);
});

function mockStdio() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const layer = Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () =>
        Sink.forEach((item: string | Uint8Array) =>
          Effect.sync(() => {
            stdout.push(typeof item === "string" ? item : new TextDecoder().decode(item));
          }),
        ),
      stderr: () =>
        Sink.forEach((item: string | Uint8Array) =>
          Effect.sync(() => {
            stderr.push(typeof item === "string" ? item : new TextDecoder().decode(item));
          }),
        ),
    }),
  );
  return { layer, stdout, stderr };
}

function getFailError(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  const fail = exit.cause.reasons.find(Cause.isFailReason);
  if (!fail) throw new Error("Expected fail reason");
  return fail.error;
}

describe("Output", () => {
  describe("text layer", () => {
    const layer = textOutputLayer.pipe(Layer.provide(mockTty({ stdoutIsTty: true })));

    it.effect("interactive reflects Tty.stdoutIsTty", () =>
      Effect.gen(function* () {
        const out = yield* Output;
        expect(out.interactive).toBe(true);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("intro calls clack intro", () =>
      Effect.gen(function* () {
        const out = yield* Output;
        yield* out.intro("Welcome");
        expect(mockClack.intro).toHaveBeenCalledWith("Welcome");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("outro calls clack outro", () =>
      Effect.gen(function* () {
        const out = yield* Output;
        yield* out.outro("Goodbye");
        expect(mockClack.outro).toHaveBeenCalledWith("Goodbye");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("info calls log.info", () =>
      Effect.gen(function* () {
        const out = yield* Output;
        yield* out.info("info message");
        expect(mockClack.log.info).toHaveBeenCalledWith("info message");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("warn calls log.warn", () =>
      Effect.gen(function* () {
        const out = yield* Output;
        yield* out.warn("warning message");
        expect(mockClack.log.warn).toHaveBeenCalledWith("warning message");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("error calls log.error", () =>
      Effect.gen(function* () {
        const out = yield* Output;
        yield* out.error("error message");
        expect(mockClack.log.error).toHaveBeenCalledWith("error message");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("success calls log.success", () =>
      Effect.gen(function* () {
        const out = yield* Output;
        yield* out.success("done!");
        expect(mockClack.log.success).toHaveBeenCalledWith("done!");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("fail is a no-op", () =>
      Effect.gen(function* () {
        const out = yield* Output;
        yield* out.fail({ code: "E_TEST", message: "test error" });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("promptText returns value", () => {
      mockClack.text.mockResolvedValue("user input");
      return Effect.gen(function* () {
        const out = yield* Output;
        const result = yield* out.promptText("Enter value");
        expect(result).toBe("user input");
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptText passes validate callback to clack", () => {
      mockClack.text.mockImplementation(
        (opts: { validate?: (v: string | undefined) => string | undefined }) => {
          // Call with a non-empty value (exercises the non-nullish branch of v ?? "")
          const validationResult = opts.validate?.("bad");
          expect(validationResult).toBe("invalid input");
          // Call with undefined (exercises the nullish branch of v ?? "")
          const validationResultUndefined = opts.validate?.(undefined);
          expect(validationResultUndefined).toBe("invalid input");
          return Promise.resolve("good input");
        },
      );
      return Effect.gen(function* () {
        const out = yield* Output;
        const result = yield* out.promptText("Enter value", {
          validate: (v: string) => (v === "good input" ? undefined : "invalid input"),
        });
        expect(result).toBe("good input");
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptText interrupts on cancel", () => {
      mockClack.text.mockResolvedValue(Symbol.for("clack:cancel"));
      mockClack.isCancel.mockReturnValue(true);
      return Effect.gen(function* () {
        const out = yield* Output;
        const exit = yield* out.promptText("Enter value").pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptPassword returns trimmed value", () => {
      mockClack.password.mockResolvedValue("  secret  ");
      return Effect.gen(function* () {
        const out = yield* Output;
        const result = yield* out.promptPassword("Enter password");
        expect(result).toBe("secret");
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptPassword interrupts on cancel", () => {
      mockClack.password.mockResolvedValue(Symbol.for("clack:cancel"));
      mockClack.isCancel.mockReturnValue(true);
      return Effect.gen(function* () {
        const out = yield* Output;
        const exit = yield* out.promptPassword("Enter password").pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptConfirm returns boolean", () => {
      mockClack.confirm.mockResolvedValue(true);
      return Effect.gen(function* () {
        const out = yield* Output;
        const result = yield* out.promptConfirm("Confirm?");
        expect(result).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptConfirm interrupts on cancel", () => {
      mockClack.confirm.mockResolvedValue(Symbol.for("clack:cancel"));
      mockClack.isCancel.mockReturnValue(true);
      return Effect.gen(function* () {
        const out = yield* Output;
        const exit = yield* out.promptConfirm("Confirm?").pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        }
      }).pipe(Effect.provide(layer));
    });
  });

  describe("json layer", () => {
    it.effect("interactive is false", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        expect(out.interactive).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.effect("intro writes to stderr", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.intro("JSON mode");
        expect(mock.stderr).toContainEqual("JSON mode\n");
      }).pipe(Effect.provide(layer));
    });

    it.effect("outro writes to stderr", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.outro("Done");
        expect(mock.stderr).toContainEqual("Done\n");
      }).pipe(Effect.provide(layer));
    });

    it.effect("info writes to stderr", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.info("info msg");
        expect(mock.stderr).toContainEqual("info msg\n");
      }).pipe(Effect.provide(layer));
    });

    it.effect("warn writes to stderr", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.warn("warn msg");
        expect(mock.stderr).toContainEqual("warn msg\n");
      }).pipe(Effect.provide(layer));
    });

    it.effect("error writes to stderr", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.error("error msg");
        expect(mock.stderr).toContainEqual("error msg\n");
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptText fails with NonInteractiveError", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        const exit = yield* out.promptText("Input").pipe(Effect.exit);
        expect(getFailError(exit)).toBeInstanceOf(NonInteractiveError);
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptPassword fails with NonInteractiveError", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        const exit = yield* out.promptPassword("Password").pipe(Effect.exit);
        expect(getFailError(exit)).toBeInstanceOf(NonInteractiveError);
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptConfirm fails with NonInteractiveError", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        const exit = yield* out.promptConfirm("Confirm?").pipe(Effect.exit);
        expect(getFailError(exit)).toBeInstanceOf(NonInteractiveError);
      }).pipe(Effect.provide(layer));
    });

    it.effect("success writes JSON to stdout", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.success("ok", { id: 42 });
        expect(mock.stdout).toHaveLength(1);
        const parsed = JSON.parse(mock.stdout[0]!);
        expect(parsed).toEqual({ id: 42, message: "ok" });
      }).pipe(Effect.provide(layer));
    });

    it.effect("fail writes JSON error to stdout", () => {
      const mock = mockStdio();
      const layer = jsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.fail({ code: "E_TEST", message: "failed", detail: "details" });
        expect(mock.stdout).toHaveLength(1);
        const parsed = JSON.parse(mock.stdout[0]!);
        expect(parsed).toEqual({
          _tag: "Error",
          error: { code: "E_TEST", message: "failed", detail: "details" },
        });
      }).pipe(Effect.provide(layer));
    });
  });

  describe("stream-json layer", () => {
    it.effect("interactive is false", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        expect(out.interactive).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.effect("intro emits NDJSON log info event", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.intro("Starting up");
        expect(mock.stdout).toHaveLength(1);
        const parsed = JSON.parse(mock.stdout[0]!);
        expect(parsed.type).toBe("log");
        expect(parsed.level).toBe("info");
        expect(parsed.message).toBe("Starting up");
        expect(parsed.timestamp).toBeDefined();
      }).pipe(Effect.provide(layer));
    });

    it.effect("outro emits NDJSON log info event", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.outro("All done");
        expect(mock.stdout).toHaveLength(1);
        const parsed = JSON.parse(mock.stdout[0]!);
        expect(parsed.type).toBe("log");
        expect(parsed.level).toBe("info");
        expect(parsed.message).toBe("All done");
        expect(parsed.timestamp).toBeDefined();
      }).pipe(Effect.provide(layer));
    });

    it.effect("info emits NDJSON log event", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.info("stream info");
        expect(mock.stdout).toHaveLength(1);
        const parsed = JSON.parse(mock.stdout[0]!);
        expect(parsed.type).toBe("log");
        expect(parsed.level).toBe("info");
        expect(parsed.message).toBe("stream info");
        expect(parsed.timestamp).toBeDefined();
      }).pipe(Effect.provide(layer));
    });

    it.effect("warn emits NDJSON warn event", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.warn("stream warn");
        const parsed = JSON.parse(mock.stdout[0]!);
        expect(parsed.type).toBe("log");
        expect(parsed.level).toBe("warn");
        expect(parsed.message).toBe("stream warn");
      }).pipe(Effect.provide(layer));
    });

    it.effect("error emits NDJSON error event", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.error("stream error");
        const parsed = JSON.parse(mock.stdout[0]!);
        expect(parsed.type).toBe("log");
        expect(parsed.level).toBe("error");
        expect(parsed.message).toBe("stream error");
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptText fails with NonInteractiveError", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        const exit = yield* out.promptText("Input").pipe(Effect.exit);
        expect(getFailError(exit)).toBeInstanceOf(NonInteractiveError);
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptPassword fails with NonInteractiveError", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        const exit = yield* out.promptPassword("Password").pipe(Effect.exit);
        expect(getFailError(exit)).toBeInstanceOf(NonInteractiveError);
      }).pipe(Effect.provide(layer));
    });

    it.effect("promptConfirm fails with NonInteractiveError", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        const exit = yield* out.promptConfirm("Confirm?").pipe(Effect.exit);
        expect(getFailError(exit)).toBeInstanceOf(NonInteractiveError);
      }).pipe(Effect.provide(layer));
    });

    it.effect("success emits result event", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.success("done", { key: "value" });
        const parsed = JSON.parse(mock.stdout[0]!);
        expect(parsed.type).toBe("result");
        expect(parsed.data).toEqual({ key: "value", message: "done" });
        expect(parsed.timestamp).toBeDefined();
      }).pipe(Effect.provide(layer));
    });

    it.effect("fail emits error event", () => {
      const mock = mockStdio();
      const layer = streamJsonOutputLayer.pipe(Layer.provide(mock.layer));
      return Effect.gen(function* () {
        const out = yield* Output;
        yield* out.fail({ code: "E_FAIL", message: "boom", suggestion: "try again" });
        const parsed = JSON.parse(mock.stdout[0]!);
        expect(parsed.type).toBe("error");
        expect(parsed.error).toEqual({
          code: "E_FAIL",
          message: "boom",
          suggestion: "try again",
        });
        expect(parsed.timestamp).toBeDefined();
      }).pipe(Effect.provide(layer));
    });
  });

  describe("layerFor", () => {
    it.effect("returns text layer for 'text'", () => {
      const mock = mockStdio();
      const layer = outputLayerFor("text").pipe(
        Layer.provide(Layer.mergeAll(mock.layer, mockTty({ stdoutIsTty: true }))),
      );
      return Effect.gen(function* () {
        const out = yield* Output;
        expect(out.format).toBe("text");
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns json layer for 'json'", () => {
      const mock = mockStdio();
      const layer = outputLayerFor("json").pipe(
        Layer.provide(Layer.mergeAll(mock.layer, mockTty({ stdoutIsTty: false }))),
      );
      return Effect.gen(function* () {
        const out = yield* Output;
        expect(out.format).toBe("json");
      }).pipe(Effect.provide(layer));
    });

    it.effect("returns stream-json layer for 'stream-json'", () => {
      const mock = mockStdio();
      const layer = outputLayerFor("stream-json").pipe(
        Layer.provide(Layer.mergeAll(mock.layer, mockTty({ stdoutIsTty: false }))),
      );
      return Effect.gen(function* () {
        const out = yield* Output;
        expect(out.format).toBe("stream-json");
      }).pipe(Effect.provide(layer));
    });
  });
});
