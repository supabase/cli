import { Option } from "effect";

/** `-o json|yaml|toml|env|csv`: the formats whose stdout is a payload rather than a human table. */
export const isMachineResourceFormat = (resourceOutput: Option.Option<string>): boolean => {
  const format = Option.getOrUndefined(resourceOutput);
  return format !== undefined && format !== "pretty" && format !== "table";
};
