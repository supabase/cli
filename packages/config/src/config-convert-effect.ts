import { Effect } from "effect";
import {
  CliConfigConvertError,
  type CliConfigConverted,
  convertCliConfigTomlToJsonc as convertPlain,
} from "./config-convert.ts";

/** The Effect form of the plain converter: a refusal fails typed, anything else is a defect. */
export const convertCliConfigTomlToJsonc = (
  source: string,
): Effect.Effect<CliConfigConverted, CliConfigConvertError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(convertPlain(source));
    } catch (error) {
      return error instanceof CliConfigConvertError ? Effect.fail(error) : Effect.die(error);
    }
  });
