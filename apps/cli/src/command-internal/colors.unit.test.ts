import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ColorStream } from "./colors.ts";
import { aqua, bold, green, red, yellow } from "./colors.ts";

// Bun's `util.styleText` ignores `validateStream` (verified on Bun 1.3.14: a
// piped stdout still gets `\x1b[36m…\x1b[39m`, even under NO_COLOR=1), so
// `colors.ts` implements termenv's gate itself — the same decision
// order the established lipgloss-style default renderer uses. These tests pin
// that gate deterministically with fake
// streams and stubbed env vars; a piped stream (no `hasColors`) must yield
// PLAIN text, exactly like the established behavior under a piped stdout.
const colorTty: ColorStream = { hasColors: () => true };
const monoTty: ColorStream = { hasColors: () => false };
const piped: ColorStream = {};

beforeEach(() => {
  // Neutralize the ambient environment (CI sets `CI`, developers may set
  // NO_COLOR) so each case controls the gate's inputs exactly. Empty string
  // reads as unset for every variable termenv consults.
  vi.stubEnv("NO_COLOR", "");
  vi.stubEnv("CLICOLOR", "");
  vi.stubEnv("CLICOLOR_FORCE", "");
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("colors TTY gating (termenv parity)", () => {
  it("styles on a colour-capable TTY", () => {
    expect(aqua("supabase", colorTty)).toBe("\u001b[36msupabase\u001b[39m");
    expect(bold("text", colorTty)).toBe("\u001b[1mtext\u001b[22m");
    expect(yellow("warning", colorTty)).toBe("\u001b[33mwarning\u001b[39m");
    expect(red("error", colorTty)).toBe("\u001b[31merror\u001b[39m");
    expect(green("label", colorTty)).toBe("\u001b[32mlabel\u001b[39m");
  });

  it("renders plain on a piped stream (no hasColors), like lipgloss's Ascii profile", () => {
    expect(aqua("supabase", piped)).toBe("supabase");
    expect(bold("text", piped)).toBe("text");
    expect(yellow("warning", piped)).toBe("warning");
    expect(red("error", piped)).toBe("error");
    expect(green("label", piped)).toBe("label");
  });

  it("renders plain on a TTY that reports no colour support (e.g. TERM=dumb)", () => {
    expect(aqua("supabase", monoTty)).toBe("supabase");
  });

  it("NO_COLOR beats everything, including CLICOLOR_FORCE (termenv EnvNoColor)", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("CLICOLOR_FORCE", "1");
    expect(aqua("supabase", colorTty)).toBe("supabase");
  });

  it("CLICOLOR=0 disables colour on a capable TTY", () => {
    vi.stubEnv("CLICOLOR", "0");
    expect(aqua("supabase", colorTty)).toBe("supabase");
  });

  it("CLICOLOR_FORCE forces colour even when piped, and overrides CLICOLOR=0", () => {
    vi.stubEnv("CLICOLOR", "0");
    vi.stubEnv("CLICOLOR_FORCE", "1");
    expect(aqua("supabase", piped)).toBe("\u001b[36msupabase\u001b[39m");
  });

  it("CLICOLOR_FORCE=0 does not force", () => {
    vi.stubEnv("CLICOLOR_FORCE", "0");
    expect(aqua("supabase", piped)).toBe("supabase");
  });

  it("CI is treated as non-TTY (termenv isTTY)", () => {
    vi.stubEnv("CI", "true");
    expect(aqua("supabase", colorTty)).toBe("supabase");
  });

  it("defaults to gating on stderr when no stream is given", () => {
    // The live TTY-ness of the test process's stderr is environment-dependent,
    // so pin the gate closed via the CI branch: the default-stream form must
    // still come back plain, proving the default threads through the gate.
    vi.stubEnv("CI", "true");
    expect(aqua("supabase")).toBe("supabase");
    expect(bold("text")).toBe("text");
  });
});
