import { Config, Effect, Option } from "effect";

/** A variable from the ambient config provider; unset or unreadable is none. */
export const envOption = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.string(name)).pipe(Effect.orElseSucceed(() => Option.none<string>()));

export const envValue = (name: string): Effect.Effect<string | undefined> =>
  Effect.map(envOption(name), Option.getOrUndefined);
