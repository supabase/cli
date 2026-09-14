import { Effect, Option } from "effect";
import { OutputFlag } from "./global-flags.ts";
import { Output } from "../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "./go-output.encoders.ts";

const payloadFormats = new Set(["json", "yaml", "toml", "env"]);

/** Output policy for structured resources without a command-specific encoding. */
export function resourceOutput<E>(EnvNotSupportedError: new (args: { message: string }) => E) {
  const requested = Effect.gen(function* () {
    const format = Option.getOrUndefined(yield* OutputFlag);
    return format !== undefined && payloadFormats.has(format);
  });

  // Call before mutations; emit also checks as a backstop.
  const rejectEnv = Effect.gen(function* () {
    if (Option.getOrUndefined(yield* OutputFlag) === "env") {
      return yield* Effect.fail(
        new EnvNotSupportedError({ message: "--output env flag is not supported" }),
      );
    }
  });

  const emit = Effect.fnUntraced(function* (payload: Record<string, unknown>) {
    if (!(yield* requested)) return false;
    yield* rejectEnv;
    const output = yield* Output;
    const format = Option.getOrUndefined(yield* OutputFlag);
    switch (format) {
      case "json":
        yield* output.raw(encodeGoJson(payload));
        break;
      case "yaml":
        yield* output.raw(encodeYaml(payload));
        break;
      case "toml":
        yield* output.raw(encodeToml(payload));
        break;
    }
    return true;
  });

  return { emit, requested: () => requested, rejectEnv: () => rejectEnv };
}
