import { CliOutput } from "effect/unstable/cli";
import { stripHiddenFlagsFromHelpDoc } from "../cli/hidden-flag.ts";

export function textCliOutputFormatter(): CliOutput.Formatter {
  const base = CliOutput.defaultFormatter({ colors: false });
  return {
    ...base,
    formatHelpDoc: (doc) => base.formatHelpDoc(stripHiddenFlagsFromHelpDoc(doc)),
    formatVersion: (_name, version) => version,
  };
}
