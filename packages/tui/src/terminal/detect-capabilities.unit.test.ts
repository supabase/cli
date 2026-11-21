import { describe, expect, it } from "vitest";

import { detectCapabilities, type CapabilityFacts } from "./detect-capabilities.ts";

const tty = (env: CapabilityFacts["env"], overrides: Partial<CapabilityFacts> = {}) =>
  detectCapabilities({
    env,
    output: { isTTY: true, columns: 100, rows: 40 },
    input: { isTTY: true },
    ...overrides,
  });

describe("detectCapabilities color level", () => {
  it.each([
    ["NO_COLOR set", { NO_COLOR: "1", TERM: "xterm-256color" }, 0],
    ["NO_COLOR beats FORCE_COLOR", { NO_COLOR: "1", FORCE_COLOR: "3" }, 0],
    ["empty NO_COLOR is ignored", { NO_COLOR: "", TERM: "xterm-256color" }, 2],
    ["FORCE_COLOR=0", { FORCE_COLOR: "0", COLORTERM: "truecolor" }, 0],
    ["FORCE_COLOR=false", { FORCE_COLOR: "false", COLORTERM: "truecolor" }, 0],
    ["FORCE_COLOR=1", { FORCE_COLOR: "1", COLORTERM: "truecolor" }, 1],
    ["FORCE_COLOR=true", { FORCE_COLOR: "true" }, 1],
    ["empty FORCE_COLOR", { FORCE_COLOR: "" }, 1],
    ["FORCE_COLOR=2", { FORCE_COLOR: "2" }, 2],
    ["FORCE_COLOR=3", { FORCE_COLOR: "3" }, 3],
    ["FORCE_COLOR above range", { FORCE_COLOR: "9" }, 3],
    ["TERM=dumb", { TERM: "dumb", COLORTERM: "truecolor" }, 0],
    ["COLORTERM=truecolor", { COLORTERM: "truecolor", TERM: "xterm" }, 3],
    ["COLORTERM=24bit", { COLORTERM: "24bit" }, 3],
    ["256color TERM", { TERM: "xterm-256color" }, 2],
    ["plain TERM", { TERM: "xterm" }, 1],
    ["no TERM", {}, 1],
  ] as const)("%s", (_name, env, expected) => {
    expect(tty(env).colorLevel).toBe(expected);
  });

  it("is 0 for a non-TTY output unless FORCE_COLOR asks for color", () => {
    const facts = { output: { isTTY: false }, input: { isTTY: false } } as const;
    expect(detectCapabilities({ ...facts, env: { TERM: "xterm-256color" } }).colorLevel).toBe(0);
    expect(detectCapabilities({ ...facts, env: { FORCE_COLOR: "2" } }).colorLevel).toBe(2);
  });
});

describe("detectCapabilities styling", () => {
  it.each([
    ["a TTY", { TERM: "xterm-256color" }, true],
    ["NO_COLOR on a TTY, which only forbids color", { NO_COLOR: "1", TERM: "xterm" }, true],
    ["TERM=dumb", { TERM: "dumb" }, false],
    ["FORCE_COLOR=0", { FORCE_COLOR: "0", TERM: "xterm" }, false],
    ["FORCE_COLOR=2 on TERM=dumb", { FORCE_COLOR: "2", TERM: "dumb" }, true],
  ] as const)("%s", (_name, env, expected) => {
    expect(tty(env).isStyled).toBe(expected);
  });

  it("is false for a non-TTY output unless FORCE_COLOR asks for styling", () => {
    const facts = { output: { isTTY: false }, input: { isTTY: false } } as const;
    expect(detectCapabilities({ ...facts, env: { TERM: "xterm-256color" } }).isStyled).toBe(false);
    expect(detectCapabilities({ ...facts, env: { FORCE_COLOR: "1" } }).isStyled).toBe(true);
  });

  it("keeps styling while NO_COLOR removes color even under FORCE_COLOR", () => {
    expect(tty({ NO_COLOR: "1", FORCE_COLOR: "3" })).toMatchObject({
      colorLevel: 0,
      isStyled: true,
    });
  });
});

describe("detectCapabilities live and interactive", () => {
  it("is live and interactive for TTY input and output", () => {
    expect(tty({ TERM: "xterm" })).toMatchObject({ live: true, interactive: true });
  });

  it("is not live for TERM=dumb", () => {
    expect(tty({ TERM: "dumb" })).toMatchObject({ live: false, interactive: false });
  });

  it("is not live for piped output, so a TTY input alone is not interactive", () => {
    const capabilities = detectCapabilities({
      env: { TERM: "xterm" },
      output: { isTTY: false },
      input: { isTTY: true },
    });
    expect(capabilities).toMatchObject({ live: false, interactive: false });
  });

  it("is live but not interactive for piped input", () => {
    const capabilities = detectCapabilities({
      env: { TERM: "xterm" },
      output: { isTTY: true },
      input: { isTTY: false },
    });
    expect(capabilities).toMatchObject({ live: true, interactive: false });
  });
});

describe("detectCapabilities size", () => {
  it("uses the stream size when known", () => {
    expect(tty({}).output).toEqual({ isTTY: true, columns: 100, rows: 40 });
  });

  it("falls back to COLUMNS and LINES, then 80x24", () => {
    const unknown = { output: { isTTY: false }, input: { isTTY: false } } as const;
    expect(detectCapabilities({ ...unknown, env: { COLUMNS: "132", LINES: "50" } }).output).toEqual(
      { isTTY: false, columns: 132, rows: 50 },
    );
    expect(detectCapabilities({ ...unknown, env: {} }).output).toEqual({
      isTTY: false,
      columns: 80,
      rows: 24,
    });
  });
});

describe("detectCapabilities unicode", () => {
  it.each([
    ["UTF-8 LANG", { LANG: "en_US.UTF-8" }, true],
    ["utf8 spelling", { LC_ALL: "C.utf8" }, true],
    ["LC_ALL wins over LANG", { LC_ALL: "C", LANG: "en_US.UTF-8" }, false],
    ["non-UTF-8 locale", { LANG: "en_US.ISO-8859-1" }, false],
    ["Windows Terminal", { WT_SESSION: "abc", LANG: "C" }, true],
    ["Linux console", { TERM: "linux", LANG: "en_US.UTF-8" }, false],
  ] as const)("%s", (_name, env, expected) => {
    expect(tty(env).unicode).toBe(expected);
  });

  it("assumes unicode without a locale, except on Windows", () => {
    expect(tty({}, { platform: "linux" }).unicode).toBe(true);
    expect(tty({}, { platform: "win32" }).unicode).toBe(false);
  });
});
