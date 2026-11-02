import { Logger, type LogLevel } from "effect";

/** Captures rendered log lines at the given levels into `lines` for assertions in tests. */
export const captureLogs = (levels: ReadonlyArray<LogLevel.LogLevel>) => (lines: Array<string>) =>
  Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (levels.some((level) => level === logLevel))
        lines.push((Array.isArray(message) ? message : [message]).map(String).join(" "));
    }),
  ]);
