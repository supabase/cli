import { CliOutput } from "effect/unstable/cli";

export function textCliOutputFormatter(): CliOutput.Formatter {
  const base = CliOutput.defaultFormatter({ colors: false });
  return {
    ...base,
    formatVersion: (_name, version) => version,
  };
}
