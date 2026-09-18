import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { StackPreparationError } from "../public/Errors.ts";
import { encodeRuntimeEnvFile } from "./RuntimeEnvFile.ts";

describe("encodeRuntimeEnvFile", () => {
  it.effect("encodes sorted NAME=value lines", () =>
    Effect.gen(function* () {
      const text = yield* encodeRuntimeEnvFile({ ZETA: "2", ALPHA: "1" });
      expect(text).toBe("ALPHA=1\nZETA=2\n");
    }),
  );

  it.effect("rejects CR/LF in a value", () =>
    Effect.gen(function* () {
      const exit = yield* encodeRuntimeEnvFile({ POSTGRES_PASSWORD: "x\ny" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(StackPreparationError);
      if (!(error instanceof StackPreparationError)) return;
      expect(error.message).toBe("Invalid runtime environment variable value");
    }),
  );

  it.effect("rejects CR/LF in a name", () =>
    Effect.gen(function* () {
      const exit = yield* encodeRuntimeEnvFile({ "FOO\nBAR": "1" }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(StackPreparationError);
      if (!(error instanceof StackPreparationError)) return;
      expect(error.message).toBe("Invalid runtime environment variable name");
    }),
  );
});
