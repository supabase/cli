import { describe, expect, it } from "vitest";

import { parseDotEnv } from "./legacy-dotenv.ts";

describe("parseDotEnv", () => {
  it("parses KEY=VALUE lines, skipping comments and blanks, and strips quotes", () => {
    expect(parseDotEnv('# comment\nFOO=bar\n\nBAZ="quoted"\nexport QUX=1')).toEqual({
      FOO: "bar",
      BAZ: "quoted",
      QUX: "1",
    });
  });

  it("expands escape sequences in double-quoted values (godotenv parity)", () => {
    expect(parseDotEnv('A="line1\\nline2"\nB="a\\"b\\\\c"')).toEqual({
      A: "line1\nline2",
      B: 'a"b\\c',
    });
  });

  it("takes single-quoted values literally (no escape expansion)", () => {
    expect(parseDotEnv("A='line1\\nline2'")).toEqual({ A: "line1\\nline2" });
  });

  it("strips unquoted inline comments preceded by whitespace (godotenv parity)", () => {
    // A `#` after whitespace begins a comment; a `#` with no leading space is
    // part of the value.
    expect(parseDotEnv("DB_PORT=54323 # local db")).toEqual({ DB_PORT: "54323" });
    expect(parseDotEnv("A=foo#bar")).toEqual({ A: "foo#bar" });
    expect(parseDotEnv("A=foo\t# tab comment")).toEqual({ A: "foo" });
  });

  it("ignores a trailing comment after a quoted value", () => {
    expect(parseDotEnv('A="quoted value" # trailing comment')).toEqual({ A: "quoted value" });
    expect(parseDotEnv("B='has # hash inside' # comment")).toEqual({ B: "has # hash inside" });
  });

  it("throws on an unterminated quoted value", () => {
    expect(() => parseDotEnv('A="unterminated')).toThrow(/unterminated quoted value/);
  });

  it("throws Go's 'unexpected character' error on a malformed variable name", () => {
    expect(() => parseDotEnv("!=")).toThrow(/unexpected character "!" in variable name/);
  });
});
