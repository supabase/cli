import { describe, expect, it } from "vitest";
import { resolveLegacyDbTargetFlags } from "./legacy-db-target-flags.ts";

describe("resolveLegacyDbTargetFlags", () => {
  it("returns empty setFlags and undefined connType when no args", () => {
    const result = resolveLegacyDbTargetFlags([]);
    expect(result.setFlags).toEqual([]);
    expect(result.connType).toBeUndefined();
  });

  it("detects --linked as changed (connType='linked')", () => {
    const result = resolveLegacyDbTargetFlags(["--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("detects --linked=false as changed (Changed, not value)", () => {
    const result = resolveLegacyDbTargetFlags(["db", "lint", "--linked=false"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("detects --no-linked as changed (boolean negation is still Changed)", () => {
    const result = resolveLegacyDbTargetFlags(["--no-linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("detects --db-url as changed", () => {
    const result = resolveLegacyDbTargetFlags(["--db-url", "postgres://x"]);
    expect(result.connType).toBe("db-url");
    expect(result.setFlags).toEqual(["db-url"]);
  });

  it("detects --db-url=<value> as changed", () => {
    const result = resolveLegacyDbTargetFlags(["--db-url=postgres://x"]);
    expect(result.connType).toBe("db-url");
    expect(result.setFlags).toEqual(["db-url"]);
  });

  it("--local=false --linked produces setFlags length 2 with alphabetical order [linked local]", () => {
    const result = resolveLegacyDbTargetFlags(["--local=false", "--linked"]);
    expect(result.setFlags).toEqual(["linked", "local"]);
    expect(result.setFlags).toHaveLength(2);
    // connType: local wins over linked in Changed-first precedence
    expect(result.connType).toBe("local");
  });

  it("--db-url=postgres://x --linked produces setFlags [db-url linked] with connType=db-url", () => {
    const result = resolveLegacyDbTargetFlags(["--db-url=postgres://x", "--linked"]);
    expect(result.setFlags).toEqual(["db-url", "linked"]);
    expect(result.connType).toBe("db-url");
  });

  it("tokens after bare -- are not scanned (end-of-options sentinel)", () => {
    const result = resolveLegacyDbTargetFlags(["--", "--linked"]);
    expect(result.setFlags).toEqual([]);
    expect(result.connType).toBeUndefined();
  });

  it("--db-url (key only, value as next arg) is still detected as changed", () => {
    // `--db-url` matches the token exactly, even without `=value`.
    const result = resolveLegacyDbTargetFlags(["--db-url", "postgres://x"]);
    expect(result.connType).toBe("db-url");
    expect(result.setFlags).toEqual(["db-url"]);
  });

  it("setFlags order is always alphabetical [db-url, linked, local] regardless of argv order", () => {
    // All three present — setFlags must be sorted to match cobra's %v rendering.
    const result = resolveLegacyDbTargetFlags(["--local", "--db-url=x", "--linked"]);
    expect(result.setFlags).toEqual(["db-url", "linked", "local"]);
  });

  it("Changed-first precedence: db-url > local > linked", () => {
    // db-url wins when all three are present
    const all = resolveLegacyDbTargetFlags(["--db-url=x", "--linked", "--local"]);
    expect(all.connType).toBe("db-url");

    // local wins over linked when db-url absent
    const localLinked = resolveLegacyDbTargetFlags(["--linked", "--local"]);
    expect(localLinked.connType).toBe("local");

    // linked wins when only linked is present
    const linkedOnly = resolveLegacyDbTargetFlags(["--linked"]);
    expect(linkedOnly.connType).toBe("linked");
  });

  it("skips value token after bare --schema so --linked is not a false positive", () => {
    // `--schema --linked` in space form: --linked is the VALUE of --schema, not a flag.
    const result = resolveLegacyDbTargetFlags(["db", "lint", "--schema", "--linked"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("skips value token after bare --level so following flags are not false positives", () => {
    const result = resolveLegacyDbTargetFlags(["--level", "error", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--schema=value (attached form) does NOT skip the next token", () => {
    // `--schema=public --linked`: --linked is a real flag here.
    const result = resolveLegacyDbTargetFlags(["--schema=public", "--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("skips value token after bare -s (short for --schema)", () => {
    // `-s --linked`: --linked is the VALUE of -s, not a flag.
    const result = resolveLegacyDbTargetFlags(["-s", "--linked"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("-svalue (attached short form) does NOT skip the next token", () => {
    // `-spublic --linked`: --linked is a real flag.
    const result = resolveLegacyDbTargetFlags(["-spublic", "--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("skips value token after bare --output so following flags are not false positives", () => {
    // --output is a value-consuming global flag.
    const result = resolveLegacyDbTargetFlags(["--output", "json", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--output-dir <value> does NOT mark --local as changed (value consumed)", () => {
    // inspect report has --output-dir (StringVar, no short alias). In space form
    // the next token is the dir value, not a flag. Without output-dir in the
    // value-consuming set, --local would be falsely detected as changed.
    const result = resolveLegacyDbTargetFlags(["--output-dir", "--local"]);
    expect(result.connType).toBeUndefined();
    expect(result.setFlags).toEqual([]);
  });

  it("--output-dir=<value> (attached form) DOES mark --local as changed", () => {
    // Attached form does not consume the next token, so --local is a real flag.
    const result = resolveLegacyDbTargetFlags(["--output-dir=./reports", "--local"]);
    expect(result.connType).toBe("local");
    expect(result.setFlags).toEqual(["local"]);
  });

  it("--schema -- --linked: -- consumed as schema value, --linked is a real flag (Go pflag parity)", () => {
    // pflag: a bare value-consuming flag consumes the very next token as its
    // value, even when that token is "--". Only a "--" with no pending value
    // terminates the scan.
    const result = resolveLegacyDbTargetFlags(["db", "lint", "--schema", "--", "--linked"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });

  it("bare -- with no pending skip still stops the scan", () => {
    // --linked sets changed; bare -- terminates; --local after is not scanned.
    const result = resolveLegacyDbTargetFlags(["--linked", "--", "--local"]);
    expect(result.connType).toBe("linked");
    expect(result.setFlags).toEqual(["linked"]);
  });
});
