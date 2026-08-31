import { Effect } from "effect";
import { LegacyInvalidGenTypesDurationError } from "./types.errors.ts";

// The local Docker container id is hoisted to `legacy/shared` so the declarative
// seam can derive the same `supabase_db_<id>` name when checking the local stack.
export { localDbContainerId } from "../../../shared/legacy-docker-ids.ts";

const DURATION_UNITS_TO_MILLIS = {
  ns: 1 / 1_000_000,
  us: 1 / 1_000,
  "\u00b5s": 1 / 1_000,
  "\u03bcs": 1 / 1_000,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;

const DURATION_PART_PATTERN = new RegExp(
  String.raw`([+-]?(?:\d+\.?\d*|\.\d+))(ns|us|\u00b5s|\u03bcs|ms|s|m|h)`,
  "g",
);

export function defaultSchemas(extraSchemas: ReadonlyArray<string> = []) {
  return [...new Set(["public", ...extraSchemas])];
}

export function parseQueryTimeoutSeconds(
  raw: string,
): Effect.Effect<number, LegacyInvalidGenTypesDurationError> {
  return Effect.gen(function* () {
    const input = raw.trim();
    if (input.length === 0) {
      return yield* Effect.fail(
        new LegacyInvalidGenTypesDurationError({
          message: `invalid duration ${JSON.stringify(raw)}`,
        }),
      );
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
        return yield* Effect.fail(
          new LegacyInvalidGenTypesDurationError({
            message: `invalid duration ${JSON.stringify(raw)}`,
          }),
        );
      }
      const amount = Number.parseFloat(rawNumber);
      const unitMillis = DURATION_UNITS_TO_MILLIS[rawUnit as keyof typeof DURATION_UNITS_TO_MILLIS];
      totalMillis += amount * unitMillis;
      consumed += token.length;
    }

    if (!Number.isFinite(totalMillis) || consumed !== input.length || totalMillis < 0) {
      return yield* Effect.fail(
        new LegacyInvalidGenTypesDurationError({
          message: `invalid duration ${JSON.stringify(raw)}`,
        }),
      );
    }

    return Math.round(totalMillis / 1_000);
  });
}

export function localDbPassword() {
  return process.env["SUPABASE_DB_PASSWORD"] ?? "postgres";
}
