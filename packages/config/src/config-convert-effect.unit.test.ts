import { describe, expect, test } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { CliConfigConvertError } from "./config-convert.ts";
import { convertCliConfigTomlToJsonc } from "./config-convert-effect.ts";

describe("convertCliConfigTomlToJsonc (Effect)", () => {
  test("succeeds with the converted document", () => {
    const converted = Effect.runSync(convertCliConfigTomlToJsonc("[api]\nport = 1\n"));
    expect(converted.text).toContain('"port": 1');
  });

  test("a refusal fails typed and stays catchable by tag", () => {
    const tag = Effect.runSync(
      convertCliConfigTomlToJsonc("a = 1\nwhen = 1979-05-27\n").pipe(
        Effect.catchTag("CliConfigConvertError", (error) => Effect.succeed(error)),
      ),
    );
    expect(tag).toBeInstanceOf(CliConfigConvertError);
    expect(tag).toMatchObject({ _tag: "CliConfigConvertError", reason: "unsupported_value" });
  });

  test("a non-refusal throw is a defect", () => {
    const exit = Effect.runSyncExit(convertCliConfigTomlToJsonc(undefined as never));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });
});
