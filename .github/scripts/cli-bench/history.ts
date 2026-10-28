/**
 * Run history kept inside the benchmark comment. The newest run is the comment itself; earlier
 * runs sit in a collapsed list, backed by a hidden marker so the next update can carry them on.
 * The marker is read back only from the workflow bot's own comment, and anything that does not
 * decode cleanly counts as no history.
 */

/** Earlier runs kept below the current one. */
export const MAX_PREVIOUS_RUNS = 20;
const HISTORY_MARKER = /<!-- cli-bench:history ([A-Za-z0-9+/=]+) -->/u;
const MAX_ENCODED_CHARS = 30_000;
const MAX_HEADLINE_CHARS = 100;
const SHA = /^[0-9a-f]{7,40}$/u;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/u;
const RUN_URL = /^https:\/\/[^\s)<>]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/u;

export interface RunEntry {
  /** Short commit SHA. */
  sha: string;
  /** UTC time to the minute, `YYYY-MM-DDTHH:MMZ`. */
  at: string;
  headline: string;
  url: string;
}

const isEntry = (value: unknown): value is RunEntry => {
  if (typeof value !== "object" || value === null) return false;
  const { sha, at, headline, url } = value as Record<string, unknown>;
  return (
    typeof sha === "string" &&
    SHA.test(sha) &&
    typeof at === "string" &&
    AT.test(at) &&
    typeof headline === "string" &&
    headline.length <= MAX_HEADLINE_CHARS &&
    !/[\r\n]/u.test(headline) &&
    typeof url === "string" &&
    RUN_URL.test(url)
  );
};

/** The title the renderer puts after `## CLI benchmark:`, flattened to one bounded line. */
export function headlineOf(markdown: string): string {
  const title = /^## CLI benchmark: (.+)$/mu.exec(markdown)?.[1] ?? "unknown";
  return title.replaceAll(/\s+/gu, " ").trim().slice(0, MAX_HEADLINE_CHARS);
}

/** An entry for a run, or undefined when the commit or run link is not in the expected shape. */
export function makeEntry(input: {
  sha: string;
  now: Date;
  headline: string;
  url: string;
}): RunEntry | undefined {
  const entry = {
    sha: input.sha.slice(0, 7),
    at: `${input.now.toISOString().slice(0, 16)}Z`,
    headline: input.headline,
    url: input.url,
  };
  return isEntry(entry) ? entry : undefined;
}

/** The runs recorded in a comment body, newest first; empty when the marker is absent or invalid. */
export function decodeHistory(body: string): Array<RunEntry> {
  const encoded = HISTORY_MARKER.exec(body)?.[1];
  if (encoded === undefined || encoded.length > MAX_ENCODED_CHARS) return [];
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return Array.isArray(value) && value.length <= MAX_PREVIOUS_RUNS + 1 && value.every(isEntry)
      ? value
      : [];
  } catch {
    return [];
  }
}

/** The new run first, then the earlier ones, with at most {@link MAX_PREVIOUS_RUNS} behind it. */
export function mergeHistory(
  previous: ReadonlyArray<RunEntry>,
  current: RunEntry,
): Array<RunEntry> {
  return [current, ...previous].slice(0, MAX_PREVIOUS_RUNS + 1);
}

const day = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

/**
 * The hidden marker for `entries` (current run first), preceded by a collapsed list of the
 * earlier ones when there are any. `clean` makes a headline safe to render.
 */
export function renderHistory(
  entries: ReadonlyArray<RunEntry>,
  clean: (text: string) => string,
): string {
  const marker = `<!-- cli-bench:history ${Buffer.from(JSON.stringify(entries)).toString("base64")} -->`;
  const earlier = entries.slice(1);
  if (earlier.length === 0) return marker;
  const lines = earlier.map(
    (entry) =>
      `- \`${entry.sha}\` · ${day(entry.at)} · ${clean(entry.headline)} · [run](${entry.url})`,
  );
  return ["<details><summary>Previous runs</summary>", "", ...lines, "", "</details>", marker].join(
    "\n",
  );
}
