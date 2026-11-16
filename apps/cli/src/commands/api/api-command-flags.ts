import { Option } from "effect";
import { Flag } from "effect/cli";

import type { ApiCommandFlag } from "./api-command.model.ts";

/** The value a generated flag parses to; `None` records that the flag was absent. */
export type ApiFlagValue = string | number | boolean | ReadonlyArray<string | number | boolean>;

const scalarFlag = (flag: ApiCommandFlag): Flag.Flag<string | number | boolean> => {
  if (flag.choices !== undefined && flag.choices.length > 0) {
    return Flag.Literals(flag.name, flag.choices);
  }
  switch (flag.type) {
    case "string":
      return Flag.String(flag.name);
    case "integer":
      return Flag.Int(flag.name);
    case "number":
      return Flag.Finite(flag.name);
    case "boolean":
      return Flag.Boolean(flag.name);
  }
};

/** Where a generated flag's value lands in the request. */
export type ApiFlagLocation = "query" | "header" | "body";

const describedFlag = (flag: ApiCommandFlag, location: ApiFlagLocation): string => {
  const description = flag.description ?? `Set ${flag.name}.`;
  if (!flag.required) return description;
  return location === "body"
    ? `${description} Required unless the field is in --body or --file.`
    : `${description} Required.`;
};

/**
 * Builds a flag that keeps absence distinct from every value: `Flag.optional` is the outermost
 * wrapper, a repeatable flag needs at least one occurrence once present, and a boolean can be
 * given as `false`.
 */
export const apiFlag = (
  flag: ApiCommandFlag,
  location: ApiFlagLocation,
): Flag.Flag<Option.Option<ApiFlagValue>> => {
  const described = scalarFlag(flag).pipe(Flag.withDescription(describedFlag(flag, location)));
  const shaped: Flag.Flag<ApiFlagValue> = flag.repeatable
    ? Flag.map(Flag.atLeast(described, 1), (values): ApiFlagValue => values)
    : Flag.map(described, (value): ApiFlagValue => value);
  return Flag.optional(shaped);
};
