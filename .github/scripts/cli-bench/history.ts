/**
 * Run history kept inside the benchmark comment. Each section's newest result is the section
 * itself; the results it replaced sit in a collapsed list, backed by a hidden marker so the next
 * update can carry them on. The marker is read back only from the workflow bot's own comment, and
 * anything that does not decode cleanly counts as no history.
 */

/** Parts of the comment, each written by its own run. */
export type Section = "lightweight" | "integration-heavy";
export const SECTIONS: ReadonlyArray<Section> = ["lightweight", "integration-heavy"];
export const SECTION_NAMES: Record<Section, string> = {
  lightweight: "Lightweight Commands",
  "integration-heavy": "Integration Heavy Commands",
};

/** Replaced results kept below the current ones. */
export const MAX_PREVIOUS_RUNS = 20;
const HISTORY_MARKER = /<!-- cli-bench:history ([A-Za-z0-9+/=]+) -->/u;
const MAX_ENCODED_CHARS = 30_000;
const MAX_HEADLINE_CHARS = 100;
const SHA = /^[0-9a-f]{7,40}$/u;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/u;
const RUN_URL = /^https:\/\/[^\s)<>]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/u;

export interface RunEntry {
  section: Section;
  /** Short commit SHA. */
  sha: string;
  /** UTC time to the minute, `YYYY-MM-DDTHH:MMZ`. */
  at: string;
  headline: string;
  url: string;
}

const isSection = (value: unknown): value is Section =>
  typeof value === "string" && (SECTIONS as ReadonlyArray<string>).includes(value);

const isEntry = (value: unknown): value is RunEntry => {
  if (typeof value !== "object" || value === null) return false;
  const { section, sha, at, headline, url } = value as Record<string, unknown>;
  return (
    isSection(section) &&
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

/** The title a section heading carries after its name, flattened to one bounded line. */
export function headlineOf(markdown: string): string {
  const title =
    /^#{2,3} (?:CLI benchmark(?: \([^)\n]*\))?|Lightweight Commands|Integration Heavy Commands): (.+)$/mu.exec(
      markdown,
    )?.[1] ?? "unknown";
  return title.replaceAll(/\s+/gu, " ").trim().slice(0, MAX_HEADLINE_CHARS);
}

/** An entry for a run, or undefined when the commit or run link is not in the expected shape. */
export function makeEntry(input: {
  section: Section;
  sha: string;
  now: Date;
  headline: string;
  url: string;
}): RunEntry | undefined {
  const entry = {
    section: input.section,
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
    if (!Array.isArray(value) || value.length > MAX_PREVIOUS_RUNS + SECTIONS.length) return [];
    // Entries written before comments had sections belong to the lightweight run.
    const entries = value.map((entry: unknown) =>
      typeof entry === "object" && entry !== null && !("section" in entry)
        ? { ...entry, section: "lightweight" }
        : entry,
    );
    return entries.every(isEntry) ? entries : [];
  } catch {
    return [];
  }
}

/**
 * The entries a comment shows as previous runs: everything but each section's newest entry,
 * which is the section's current result. A running section has no current result, so all of its
 * entries are previous.
 */
export function previousEntries(
  entries: ReadonlyArray<RunEntry>,
  running: ReadonlySet<Section> = new Set(),
): Array<RunEntry> {
  const seen = new Set<Section>();
  return entries.filter((entry) => {
    if (running.has(entry.section)) return true;
    if (!seen.has(entry.section)) {
      seen.add(entry.section);
      return false;
    }
    return true;
  });
}

/**
 * The new result first, then the earlier entries, keeping every section's newest entry and at
 * most {@link MAX_PREVIOUS_RUNS} older ones across both sections.
 */
export function mergeHistory(
  previous: ReadonlyArray<RunEntry>,
  current: RunEntry,
): Array<RunEntry> {
  const all = [current, ...previous];
  const seen = new Set<Section>();
  let older = 0;
  return all.filter((entry) => {
    if (!seen.has(entry.section)) {
      seen.add(entry.section);
      return true;
    }
    older += 1;
    return older <= MAX_PREVIOUS_RUNS;
  });
}

const day = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

/**
 * The hidden marker for `entries` (newest first), preceded by a collapsed list of the previous
 * ones when there are any. `clean` makes a headline safe to render.
 */
export function renderHistory(
  entries: ReadonlyArray<RunEntry>,
  clean: (text: string) => string,
  running: ReadonlySet<Section> = new Set(),
): string {
  const marker = `<!-- cli-bench:history ${Buffer.from(JSON.stringify(entries)).toString("base64")} -->`;
  const previous = previousEntries(entries, running);
  if (previous.length === 0) return marker;
  const lines = previous.map(
    (entry) =>
      `- ${SECTION_NAMES[entry.section]} · \`${entry.sha}\` · ${day(entry.at)} · ${clean(entry.headline)} · [run](${entry.url})`,
  );
  return ["<details><summary>Previous runs</summary>", "", ...lines, "", "</details>", marker].join(
    "\n",
  );
}
