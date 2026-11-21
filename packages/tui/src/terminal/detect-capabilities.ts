import type { Capabilities, ColorLevel } from "../capabilities.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export interface CapabilityFacts {
  readonly env: Env;
  readonly output: {
    readonly isTTY: boolean;
    readonly columns?: number | undefined;
    readonly rows?: number | undefined;
  };
  readonly input: { readonly isTTY: boolean };
  readonly platform?: string | undefined;
}

const defaultColumns = 80;
const defaultRows = 24;

const clampLevel = (level: number): ColorLevel =>
  level <= 0 ? 0 : level === 1 ? 1 : level === 2 ? 2 : 3;

const forcedLevel = (value: string): ColorLevel => {
  if (value === "" || value === "true") return 1;
  if (value === "false") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 1 : clampLevel(parsed);
};

const positive = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

const envNumber = (value: string | undefined): number | undefined =>
  positive(value === undefined ? undefined : Number.parseInt(value, 10));

const colorLevel = (facts: CapabilityFacts): ColorLevel => {
  const { env } = facts;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return 0;
  if (env["FORCE_COLOR"] !== undefined) return forcedLevel(env["FORCE_COLOR"]);
  if (!facts.output.isTTY || env["TERM"] === "dumb") return 0;
  if (env["COLORTERM"] === "truecolor" || env["COLORTERM"] === "24bit") return 3;
  return env["TERM"]?.includes("256color") === true ? 2 : 1;
};

const isStyled = ({ env, output }: CapabilityFacts): boolean => {
  const forced = env["FORCE_COLOR"];
  if (forced !== undefined) return forcedLevel(forced) > 0;
  return output.isTTY && env["TERM"] !== "dumb";
};

/** UTF-8 locale, Windows Terminal, or no locale off Windows; never the Linux console. */
const supportsUnicode = ({ env, platform }: CapabilityFacts): boolean => {
  if (env["TERM"] === "linux") return false;
  if (env["WT_SESSION"] !== undefined) return true;
  const locale = [env["LC_ALL"], env["LC_CTYPE"], env["LANG"]].find(
    (value) => value !== undefined && value !== "",
  );
  return locale === undefined ? platform !== "win32" : /utf-?8/i.test(locale);
};

/** Resolves color depth, unicode support, size and liveness from the environment and the streams. */
export const detectCapabilities = (facts: CapabilityFacts): Capabilities => {
  const live = facts.output.isTTY && facts.env["TERM"] !== "dumb";
  return {
    colorLevel: colorLevel(facts),
    isStyled: isStyled(facts),
    unicode: supportsUnicode(facts),
    output: {
      isTTY: facts.output.isTTY,
      columns: positive(facts.output.columns) ?? envNumber(facts.env["COLUMNS"]) ?? defaultColumns,
      rows: positive(facts.output.rows) ?? envNumber(facts.env["LINES"]) ?? defaultRows,
    },
    input: { isTTY: facts.input.isTTY },
    live,
    interactive: facts.input.isTTY && live,
  };
};
