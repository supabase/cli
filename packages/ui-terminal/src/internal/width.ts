const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const VARIATION_SELECTOR_16 = "\ufe0f";
const COMBINING_ENCLOSING_KEYCAP = "\u20e3";

const zeroWidth = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u;
const emojiPresentation = /^\p{Emoji_Presentation}$/u;

// East Asian Wide and Fullwidth blocks from Unicode EastAsianWidth.txt, rounded to block edges.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1aff0, 0x1b2ff],
  [0x1f200, 0x1f2ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const isEastAsianWide = (codePoint: number): boolean =>
  codePoint >= 0x1100 && WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);

/** Splits `text` at extended grapheme cluster boundaries, with each cluster's UTF-16 offset. */
export const segmentGraphemes = (
  text: string,
): ReadonlyArray<{ readonly text: string; readonly index: number }> =>
  Array.from(segmenter.segment(text), (part) => ({ text: part.segment, index: part.index }));

/** Splits `text` at extended grapheme cluster boundaries. */
export const graphemes = (text: string): ReadonlyArray<string> =>
  segmentGraphemes(text).map((part) => part.text);

/** A cluster is as wide as its first visible code point, or 2 cells when it asks for emoji presentation. */
const clusterWidth = (cluster: string): number => {
  const base = Array.from(cluster).find((char) => !zeroWidth.test(char));
  if (base === undefined) return 0;
  if (cluster.includes(VARIATION_SELECTOR_16) || cluster.includes(COMBINING_ENCLOSING_KEYCAP)) {
    return 2;
  }
  return emojiPresentation.test(base) || isEastAsianWide(base.codePointAt(0) ?? 0) ? 2 : 1;
};

export const isPlainAscii = (text: string): boolean => /^[\x20-\x7e]*$/.test(text);

/** Display cells `text` occupies: each grapheme cluster, including emoji sequences, is measured once. */
export const width = (text: string): number => {
  if (isPlainAscii(text)) return text.length;
  let cells = 0;
  for (const part of segmenter.segment(text)) cells += clusterWidth(part.segment);
  return cells;
};
