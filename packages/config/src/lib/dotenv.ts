export type CliProjectEnvSource = "ambient" | ".env" | ".env.local";

const dotEnvLinePattern =
  /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/;

// Matches a `KEY=<quote>` (or `KEY: <quote>`) opener, used to detect the start of a
// multiline quoted value (e.g. a PEM block) that doesn't close on the same line.
const dotEnvValueOpenerPattern = /^\s*(?:export\s+)?[\w.-]+(?:\s*=\s*?|:\s+?)(['"`])/;

function findUnescapedQuoteIndex(text: string, quote: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === quote && text[i - 1] !== "\\") {
      return i;
    }
  }
  return -1;
}

function detectOpenQuoteStart(line: string): { quote: string; openIndex: number } | null {
  const openerMatch = dotEnvValueOpenerPattern.exec(line);
  if (openerMatch === null) {
    return null;
  }
  const quote = openerMatch[1];
  if (quote === undefined) {
    return null;
  }
  const openIndex = openerMatch[0].length - 1;
  if (findUnescapedQuoteIndex(line, quote, openIndex + 1) !== -1) {
    // Already closes on this same line — this isn't the multiline case, so
    // whatever made the outer match fail is a genuine parse error.
    return null;
  }
  return { quote, openIndex };
}

function parseDotEnvValue(rawValue: string): string {
  let value = rawValue.trim();
  const maybeQuote = value[0];

  value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");

  if (maybeQuote === '"') {
    value = value.replace(/\\n/g, "\n");
    value = value.replace(/\\r/g, "\r");
  }

  return value;
}

/** Parses dotenv text; a line that is not a `KEY=value` entry fails with its 1-based number. */
export function parseDotEnvText(
  contents: string,
): { readonly values: Record<string, string> } | { readonly errorLine: number } {
  const values: Record<string, string> = {};
  const lines = contents.replace(/\r\n?/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    let candidate = line;
    let consumedThrough = index;

    // Detect an unterminated quote before the single-line match: the pattern's unquoted
    // fallback (`[^#\r\n]+`) would otherwise "succeed" with a truncated value instead of
    // signaling a multiline value (e.g. a PEM block spanning several lines). Accumulate
    // subsequent lines until the opened quote closes, then match the joined chunk.
    const opener = detectOpenQuoteStart(line);
    if (opener !== null) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const nextLine = lines[next];
        if (nextLine === undefined) {
          continue;
        }
        candidate += "\n" + nextLine;
        consumedThrough = next;
        if (findUnescapedQuoteIndex(candidate, opener.quote, opener.openIndex + 1) !== -1) {
          break;
        }
      }
    }

    const match = dotEnvLinePattern.exec(candidate);
    const key = match?.[1];

    if (match === null || key === undefined) {
      return { errorLine: index + 1 };
    }

    values[key] = parseDotEnvValue(match[2] ?? "");
    index = consumedThrough;
  }

  return { values };
}

/** Layers `.env`, `.env.local` and the ambient environment, later sources winning, and records each key's origin. */
export function layerProjectEnvironment(parts: {
  readonly env?: Readonly<Record<string, string>>;
  readonly envLocal?: Readonly<Record<string, string>>;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}): {
  readonly values: Record<string, string>;
  readonly sources: Record<string, CliProjectEnvSource>;
} {
  const values: Record<string, string> = {};
  const sources: Record<string, CliProjectEnvSource> = {};
  const apply = (
    layer: Readonly<Record<string, string | undefined>>,
    source: CliProjectEnvSource,
  ) => {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) {
        values[key] = value;
        sources[key] = source;
      }
    }
  };
  apply(parts.env ?? {}, ".env");
  apply(parts.envLocal ?? {}, ".env.local");
  apply(parts.baseEnv ?? {}, "ambient");
  return { values, sources };
}
