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

  it("accepts godotenv YAML-style colon assignments", () => {
    expect(parseDotEnv("SUPABASE_DB_PASSWORD: secret\nDB_PORT:54323")).toEqual({
      SUPABASE_DB_PASSWORD: "secret",
      DB_PORT: "54323",
    });
    // The first `=`/`:` ends the key; a separator inside the value is preserved.
    expect(parseDotEnv("DB_URL=postgres://h:5432/db")).toEqual({ DB_URL: "postgres://h:5432/db" });
  });

  it("throws on an unterminated quoted value", () => {
    expect(() => parseDotEnv('A="unterminated')).toThrow(/unterminated quoted value/);
  });

  it("throws Go's 'unexpected character' error on a malformed variable name", () => {
    expect(() => parseDotEnv("!=")).toThrow(/unexpected character "!" in variable name/);
  });

  describe("multiline quoted values (godotenv parity)", () => {
    it("scans a double-quoted value across newlines, preserving embedded newlines", () => {
      const pem = "-----BEGIN KEY-----\nline2\nline3\n-----END KEY-----";
      const env = parseDotEnv(`KEY="${pem}"\nDB_PORT=54323`);
      expect(env["KEY"]).toBe(pem);
      expect(env["DB_PORT"]).toBe("54323");
    });

    it("scans a single-quoted value across newlines literally (no expansion)", () => {
      const env = parseDotEnv("USER=alice\nA='line1\n$USER\nline3'\nB=after");
      expect(env["A"]).toBe("line1\n$USER\nline3");
      expect(env["B"]).toBe("after");
    });

    it("throws only after scanning to EOF for an unterminated multiline quote", () => {
      expect(() => parseDotEnv('A="line1\nline2 with no close')).toThrow(
        /unterminated quoted value/,
      );
    });

    it("does not let an apostrophe in a comment swallow following lines", () => {
      const env = parseDotEnv("# it's a comment\nDB_PASSWORD=secret\nDB_PORT=54323");
      expect(env).toEqual({ DB_PASSWORD: "secret", DB_PORT: "54323" });
    });
  });

  describe("variable expansion (godotenv parity)", () => {
    it("expands $VAR and ${VAR} from earlier same-file definitions", () => {
      expect(parseDotEnv("DB_PORT=54323\nSUPABASE_DB_PORT=$DB_PORT\nURL=${DB_PORT}/db")).toEqual({
        DB_PORT: "54323",
        SUPABASE_DB_PORT: "54323",
        URL: "54323/db",
      });
    });

    it("expands references inside double-quoted values", () => {
      expect(parseDotEnv('USER=alice\nDSN="postgres://$USER@h/db"')).toEqual({
        USER: "alice",
        DSN: "postgres://alice@h/db",
      });
    });

    it("does not expand inside single-quoted values", () => {
      expect(parseDotEnv("USER=alice\nA='$USER'")).toEqual({ USER: "alice", A: "$USER" });
    });

    it("keeps an escaped \\$VAR literal (backslash dropped)", () => {
      expect(parseDotEnv('A="\\$USER"')).toEqual({ A: "$USER" });
    });

    it("expands an undefined reference to the empty string", () => {
      expect(parseDotEnv("A=$MISSING")).toEqual({ A: "" });
    });

    it("returns the inner text for a $(...) form (no command substitution)", () => {
      expect(parseDotEnv("A=$(echo hi)")).toEqual({ A: "(echo hi)" });
    });

    it("leaves lowercase names unexpanded (regex matches [A-Z0-9_] only)", () => {
      expect(parseDotEnv("foo=bar\nA=$foo")).toEqual({ foo: "bar", A: "$foo" });
    });
  });
});
