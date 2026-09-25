import { Config, Effect, Option, Schema } from "effect";
import { InvalidGenTypesDurationError } from "./types.errors.ts";
import caProd2021 from "./templates/prod-ca-2021.ts";
import caProd2025 from "./templates/prod-ca-2025.ts";
import caStaging2021 from "./templates/staging-ca-2021.ts";

// Local Docker resource ids are hoisted to `command-internal` so the declarative seam
// can derive the same `supabase_db_<id>` name when checking the local stack.
export { localDbContainerId, localNetworkId } from "../../../command-internal/docker-ids.ts";

const DURATION_UNITS_TO_MILLIS: Readonly<Record<string, number>> = {
  ns: 1 / 1_000_000,
  us: 1 / 1_000,
  "\u00b5s": 1 / 1_000,
  "\u03bcs": 1 / 1_000,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

const DURATION_PART_PATTERN = new RegExp(
  String.raw`([+-]?(?:\d+\.?\d*|\.\d+))(ns|us|\u00b5s|\u03bcs|ms|s|m|h)`,
  "g",
);

const DurationJson = Schema.fromJsonString(Schema.String);

const quoteDuration = (raw: string) => Schema.encodeEffect(DurationJson)(raw).pipe(Effect.orDie);

export function defaultSchemas(extraSchemas: ReadonlyArray<string> = []) {
  return [...new Set(["public", ...extraSchemas])];
}

export function parseQueryTimeoutMillis(
  raw: string,
): Effect.Effect<number, InvalidGenTypesDurationError> {
  return Effect.gen(function* () {
    const input = raw.trim();
    if (input.length === 0) {
      return yield* new InvalidGenTypesDurationError({
        message: `invalid duration ${yield* quoteDuration(raw)}`,
      });
    }

    let totalMillis = 0;
    let consumed = 0;
    DURATION_PART_PATTERN.lastIndex = 0;
    for (const match of input.matchAll(DURATION_PART_PATTERN)) {
      const [token, rawNumber, rawUnit] = match;
      if (
        token === undefined ||
        rawNumber === undefined ||
        rawUnit === undefined ||
        match.index === undefined
      ) {
        continue;
      }
      if (match.index !== consumed) {
        return yield* new InvalidGenTypesDurationError({
          message: `invalid duration ${yield* quoteDuration(raw)}`,
        });
      }
      const amount = Number.parseFloat(rawNumber);
      const unitMillis = DURATION_UNITS_TO_MILLIS[rawUnit];
      if (unitMillis === undefined) {
        continue;
      }
      totalMillis += amount * unitMillis;
      consumed += token.length;
    }

    if (!Number.isFinite(totalMillis) || consumed !== input.length || totalMillis < 0) {
      return yield* new InvalidGenTypesDurationError({
        message: `invalid duration ${yield* quoteDuration(raw)}`,
      });
    }

    return totalMillis;
  });
}

export const localDbPassword = Effect.fnUntraced(function* () {
  const value = yield* Config.option(Config.string("SUPABASE_DB_PASSWORD"));
  return Option.getOrElse(value, () => "postgres");
});

export function rootCaBundle() {
  return `${caStaging2021}${caProd2021}${caProd2025}`;
}
