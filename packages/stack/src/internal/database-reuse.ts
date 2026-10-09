import { isOrioledbVersion, postgresLine, postgresMajor } from "../Artifacts.ts";

/** Recovery for local database data a stack cannot reuse, worded like the CLI's saved-stack advice. */
export const recreateStackAdvice = (stackId: string): string =>
  `run \`supabase stack destroy --stack-id ${stackId}\` to recreate the stack — this permanently deletes its local database data`;

/**
 * Why existing PostgreSQL data cannot serve the requested artifact version, or `undefined` when it
 * can. `PG_VERSION` proves only the major, so an unknown `line` counts as the stock line.
 */
export const unusableDatabaseData = (
  data: {
    readonly major: string;
    readonly line: string | undefined;
    readonly initialized: boolean;
  },
  version: string,
): string | undefined => {
  const subject = data.initialized
    ? "Initialized PostgreSQL data"
    : "PostgreSQL data from an unfinished first start";
  const major = postgresMajor(version);
  if (data.major !== major)
    return `${subject} is major ${data.major}, but major ${major} was requested`;
  const line = postgresLine(version);
  if (data.line === undefined)
    return isOrioledbVersion(version)
      ? "Unmarked PostgreSQL data cannot be verified as OrioleDB data"
      : undefined;
  return data.line === line
    ? undefined
    : `${subject} belongs to release line ${data.line}, but ${line} was requested`;
};
