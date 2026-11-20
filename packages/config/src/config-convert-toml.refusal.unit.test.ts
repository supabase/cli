import { describe, expect, test, vi } from "vitest";
import { CliConfigConvertError } from "./config-convert.ts";
import { convertCliConfigJsoncToToml } from "./config-convert-toml.ts";

vi.mock("./config-convert-toml-parse.ts", (importOriginal) =>
  importOriginal<typeof import("./config-convert-toml-parse.ts")>().then((actual) => ({
    ...actual,
    parseJsoncDocument: (text: string) => {
      const doc = actual.parseJsoncDocument(text);
      const unplaced = { id: doc.comments.length, line: 7, raw: "// lost", lines: [" lost"] };
      return { ...doc, comments: [...doc.comments, unplaced] };
    },
  })),
);

describe("convertCliConfigJsoncToToml comment verification", () => {
  test("refuses with the line of a comment the output does not carry", () => {
    const attempt = () => convertCliConfigJsoncToToml('{ "a": 1 }');

    expect(attempt).toThrow(CliConfigConvertError);
    expect(attempt).toThrow(
      expect.objectContaining({
        reason: "verification_mismatch",
        sourceLine: 7,
        detail: "could not place the comment on line 7; move or remove it, then rerun",
      }),
    );
  });
});
