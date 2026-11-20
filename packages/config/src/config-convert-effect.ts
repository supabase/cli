import { Effect } from "effect";
import {
  CliConfigConvertError,
  convertCliConfigTomlToJsonc as tomlToJsonc,
} from "./config-convert.ts";
import { convertCliConfigJsoncToToml as jsoncToToml } from "./config-convert-toml.ts";

const lift =
  <A>(convert: (source: string) => A) =>
  (source: string): Effect.Effect<A, CliConfigConvertError> =>
    Effect.suspend(() => {
      try {
        return Effect.succeed(convert(source));
      } catch (error) {
        return error instanceof CliConfigConvertError ? Effect.fail(error) : Effect.die(error);
      }
    });

/** The Effect form of the TOML-to-JSONC converter: a refusal fails typed, anything else is a defect. */
export const convertCliConfigTomlToJsonc = lift(tomlToJsonc);

/** The Effect form of the JSONC-to-TOML converter: a refusal fails typed, anything else is a defect. */
export const convertCliConfigJsoncToToml = lift(jsoncToToml);
