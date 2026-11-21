import { column, empty, glyph, row, text, widestLine } from "../view/public.ts";
import type { Node, Tone } from "../view/public.ts";
import { glyphs } from "./glyphs.ts";

interface Entry {
  readonly key: string;
  readonly value: string;
}

export interface KeyValueConfig {
  readonly entries: ReadonlyArray<Entry>;
  /** Colors the leading gutter glyph only; keys and values stay in `default`. */
  readonly tone?: Tone;
}

const maxKeyWidth = 24;

/**
 * Aligned bold keys beside their values, with long keys and values wrapping in their columns and an
 * optional toned gutter glyph. The block fills its parent, whose width must be definite because
 * the key column is a percentage of it.
 */
export const view = ({ entries, tone }: KeyValueConfig): Node => {
  if (entries.length === 0) return empty;
  const keyMaxWidth = Math.min(
    Math.max(...entries.map((entry) => widestLine(entry.key))),
    maxKeyWidth,
  );
  return column(
    entries.map(({ key, value }) =>
      row(
        [
          ...(tone === undefined
            ? []
            : [column([text([glyph(glyphs.bullet, { tone })])], { width: 1, shrink: 0 })]),
          column([text(key, { emphasis: "bold" })], {
            width: "50%",
            maxWidth: keyMaxWidth,
            shrink: 0,
          }),
          column([text(value)], { grow: 1, shrink: 1 }),
        ],
        { gap: 1 },
      ),
    ),
    { alignSelf: "stretch", grow: 1 },
  );
};
