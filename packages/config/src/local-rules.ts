import type { CliConfigTableRuleIssue } from "./lib/table-rule-issue.ts";

const sizeUnits: Readonly<Record<string, number>> = {
  "": 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
};
export const sizePattern = /^(\d+(?:\.\d+)?) ?(?:([kmgtp])(?:i?b)?|b)?$/iu;

function sizeInBytes(text: string): number | undefined {
  const match = sizePattern.exec(text);
  const amount = match?.[1];
  return amount === undefined
    ? undefined
    : Math.trunc(Number(amount) * (sizeUnits[(match?.[2] ?? "").toLowerCase()] ?? 1));
}

/** The smallest memory limit Docker accepts. */
const minMemoryBytes = 6 * 1024 ** 2;

export const memoryPatternMessage = "must be a size such as 512MiB or 1GiB";

/** The message for a memory size that parses but falls outside Docker's accepted range. */
export function memoryOutOfRangeMessage(value: string): string | undefined {
  const bytes = sizeInBytes(value);
  return bytes === undefined || (bytes >= minMemoryBytes && Number.isSafeInteger(bytes))
    ? undefined
    : "must be at least 6MiB and less than 8PiB";
}

/** The first problem with a `container.memory` value, or `undefined` when it is valid. */
export function memoryIssueMessage(value: string): string | undefined {
  return sizePattern.test(value) ? memoryOutOfRangeMessage(value) : memoryPatternMessage;
}

const upstreamVersion = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const malformedRevision = /-r(?:0\d+)?$/u;
const orioledbMarker = /-orioledb(?:-|$)/u;

function versionIssue(key: string, version: string, includeValues: boolean): string | undefined {
  const shown = includeValues ? ` "${version}"` : "";
  if (version === "linked" || version === "bundled") {
    return undefined;
  }
  if (key === "default") {
    return `local.services.default.version${shown} must be "linked" or "bundled"`;
  }
  if (version === "default" || !upstreamVersion.test(version) || malformedRevision.test(version)) {
    return `local.services.${key}.version${shown} must be "linked", "bundled", or an upstream version optionally followed by -r<N> (N a non-negative integer without leading zeros)`;
  }
  if (orioledbMarker.test(version) && key !== "database") {
    return `local.services.${key}.version${shown} uses the -orioledb marker, which is only valid for the database service`;
  }
  return undefined;
}

/** One issue per `[local.services.*]` entry whose version is invalid, relative to the services table; `includeValues: false` omits the rejected version. */
export function cliConfigServiceVersionIssues(
  value: { readonly [key: string]: { readonly version?: string } | undefined },
  { includeValues = true }: { readonly includeValues?: boolean } = {},
): ReadonlyArray<CliConfigTableRuleIssue> {
  return Object.entries(value).flatMap(([key, serviceEntry]) => {
    const version = serviceEntry?.version;
    const message = version === undefined ? undefined : versionIssue(key, version, includeValues);
    return message === undefined ? [] : [{ path: [key, "version"], message }];
  });
}
