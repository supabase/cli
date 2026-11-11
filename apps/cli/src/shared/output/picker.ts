import { AutocompletePrompt, SelectPrompt, isCancel } from "@clack/core";
import { Effect } from "effect";

import { aqua, muted } from "../../command-internal/colors.ts";
import { GUTTER, statusLine } from "./gutter.ts";

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly hint?: string;
}

/** The result of a picker: the chosen value, or `undefined` when the person cancelled. */
export type PickerResult = string | undefined;

const POINTER = "▸";

/**
 * Moves a list window only when the cursor reaches the row next to an edge, so the cursor travels
 * freely through the visible rows and the list scrolls one row at a time beyond them.
 */
export function scrollWindow(start: number, cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  const lead = size > 2 ? 1 : 0;
  let next = start;
  if (cursor < next + lead) next = cursor - lead;
  if (cursor > next + size - 1 - lead) next = cursor - size + 1 + lead;
  return Math.min(Math.max(next, 0), total - size);
}

const makeRenderer = (message: string, maxItems: number, stream: NodeJS.WriteStream) => {
  let start = 0;
  const optionRows = (options: ReadonlyArray<PickerOption>, cursor: number): Array<string> => {
    if (options.length === 0) return [`${GUTTER}${muted("No matches", stream)}`];
    const size = Math.min(maxItems, options.length);
    start = scrollWindow(start, cursor, options.length, size);
    const visible = options.slice(start, start + size);
    const labelWidth = Math.max(...visible.map((option) => option.label.length));
    const rows = visible.map((option, offset) => {
      const focused = start + offset === cursor;
      const label = option.detail === undefined ? option.label : option.label.padEnd(labelWidth);
      const detail = option.detail === undefined ? "" : `${GUTTER}${muted(option.detail, stream)}`;
      const hint =
        focused && option.hint !== undefined ? `${GUTTER}${muted(option.hint, stream)}` : "";
      return focused
        ? `${aqua(POINTER, stream)} ${aqua(label, stream)}${detail}${hint}`
        : `${GUTTER}${label}${detail}`;
    });
    const below = options.length - start - size;
    if (start > 0) rows.unshift(`${GUTTER}${muted(`↑ ${start} more`, stream)}`);
    if (below > 0) rows.push(`${GUTTER}${muted(`↓ ${below} more`, stream)}`);
    return rows;
  };
  const question = (answer: string) =>
    statusLine("prompt", `${message} ${answer}`, stream).trimEnd();
  return { optionRows, question };
};

const finished = (
  state: string,
  question: (answer: string) => string,
  chosen: PickerOption | undefined,
  stream: NodeJS.WriteStream,
): string | undefined => {
  if (state === "submit") return question(aqua(chosen?.label ?? "", stream));
  if (state === "cancel") return question(muted("cancelled", stream));
  return undefined;
};

/** A single-choice list: arrow keys move, Enter chooses. */
export const pickOne = (
  message: string,
  options: ReadonlyArray<PickerOption>,
  { maxItems, stream }: { readonly maxItems: number; readonly stream: NodeJS.WriteStream },
): Effect.Effect<PickerResult> =>
  Effect.suspend(() => {
    const { optionRows, question } = makeRenderer(message, maxItems, stream);
    const help = `${GUTTER}${muted("↑/↓ to move · Enter to choose", stream)}`;
    const prompt = new SelectPrompt<PickerOption>({
      options: [...options],
      output: stream,
      render() {
        return (
          finished(this.state, question, this.options[this.cursor], stream) ??
          [question(""), ...optionRows(this.options, this.cursor), help].join("\n")
        );
      },
    });
    return Effect.promise(() => prompt.prompt()).pipe(
      Effect.map((value) => (isCancel(value) ? undefined : value)),
    );
  });

/** A searchable list: typing filters by label, hint or value; arrow keys move, Enter chooses. */
export const pickWithSearch = (
  message: string,
  options: ReadonlyArray<PickerOption>,
  { maxItems, stream }: { readonly maxItems: number; readonly stream: NodeJS.WriteStream },
): Effect.Effect<PickerResult> =>
  Effect.suspend(() => {
    const { optionRows, question } = makeRenderer(message, maxItems, stream);
    const help = `${GUTTER}${muted("↑/↓ to move · Enter to choose · type to search", stream)}`;
    const prompt = new AutocompletePrompt<PickerOption>({
      options: [...options],
      output: stream,
      filter: (search, option) => {
        const needle = search.toLowerCase();
        return [option.label, option.detail ?? "", option.hint ?? "", option.value].some((field) =>
          field.toLowerCase().includes(needle),
        );
      },
      render() {
        const chosen = this.filteredOptions.find((option) => option.value === this.value);
        return (
          finished(this.state, question, chosen, stream) ??
          [
            question(this.userInputWithCursor),
            ...optionRows(this.filteredOptions, this.cursor),
            help,
          ].join("\n")
        );
      },
    });
    return Effect.promise(() => prompt.prompt()).pipe(
      Effect.map((value) => (isCancel(value) || Array.isArray(value) ? undefined : value)),
    );
  });
