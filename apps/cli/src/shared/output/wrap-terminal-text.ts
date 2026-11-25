import { stringWidth } from "../../command-internal/string-width.ts";
import { stripControlSequences } from "./strip-control-sequences.ts";

export function wrapTerminalText(text: string, width: number): string {
  const limit = Math.max(2, Math.floor(width));
  return stripControlSequences(text)
    .replaceAll("\t", "    ")
    .split("\n")
    .map((line) => {
      const lines: string[] = [];
      let current = "";
      let used = 0;
      for (const token of line.match(/\S+\s*|\s+/gu) ?? []) {
        if (used > 0 && used + stringWidth(token) > limit) {
          lines.push(current);
          current = "";
          used = 0;
        }
        for (const character of token) {
          const size = stringWidth(character);
          if (used > 0 && used + size > limit) {
            lines.push(current);
            current = "";
            used = 0;
          }
          current += character;
          used += size;
        }
      }
      return [...lines, current].join("\n");
    })
    .join("\n");
}
