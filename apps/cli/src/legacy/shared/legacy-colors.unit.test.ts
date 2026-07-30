import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LegacyColorStream } from "./legacy-colors.ts";
import { legacyAqua, legacyBold, legacyGreen, legacyRed, legacyYellow } from "./legacy-colors.ts";

// Bun's `util.styleText` ignores `validateStream` (verified on Bun 1.3.14: a
// piped stdout still gets `\x1b[36m…\x1b[39m`, even under NO_COLOR=1), so
// `legacy-colors.ts` implements termenv's gate itself — the same decision
// order Go's lipgloss default renderer uses (`termenv@v0.16.0`
// `termenv.go:68-115`). These tests pin that gate deterministically with fake
// streams and stubbed env vars; a piped stream (no `hasColors`) must yield
// PLAIN text, exactly like Go's `utils.Aqua` under `go test`'s piped stdout.
const colorTty: LegacyColorStream = { hasColors: () => true };
const monoTty: LegacyColorStream = { hasColors: () => false };
const piped: LegacyColorStream = {};

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

describe("legacy-colors TTY gating (termenv parity)", () => {
  it("styles on a colour-capable TTY", () => {
    expect(legacyAqua("supabase", colorTty)).toBe("\u001b[36msupabase\u001b[39m");
    expect(legacyBold("text", colorTty)).toBe("\u001b[1mtext\u001b[22m");
    expect(legacyYellow("warning", colorTty)).toBe("\u001b[33mwarning\u001b[39m");
    expect(legacyRed("error", colorTty)).toBe("\u001b[31merror\u001b[39m");
    expect(legacyGreen("label", colorTty)).toBe("\u001b[32mlabel\u001b[39m");
  });

  it("renders plain on a piped stream (no hasColors), like lipgloss's Ascii profile", () => {
    expect(legacyAqua("supabase", piped)).toBe("supabase");
    expect(legacyBold("text", piped)).toBe("text");
    expect(legacyYellow("warning", piped)).toBe("warning");
    expect(legacyRed("error", piped)).toBe("error");
    expect(legacyGreen("label", piped)).toBe("label");
  });

  it("renders plain on a TTY that reports no colour support (e.g. TERM=dumb)", () => {
    expect(legacyAqua("supabase", monoTty)).toBe("supabase");
  });

  it("NO_COLOR beats everything, including CLICOLOR_FORCE (termenv EnvNoColor)", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("CLICOLOR_FORCE", "1");
    expect(legacyAqua("supabase", colorTty)).toBe("supabase");
  });

  it("CLICOLOR=0 disables colour on a capable TTY", () => {
    vi.stubEnv("CLICOLOR", "0");
    expect(legacyAqua("supabase", colorTty)).toBe("supabase");
  });

  it("CLICOLOR_FORCE forces colour even when piped, and overrides CLICOLOR=0", () => {
    vi.stubEnv("CLICOLOR", "0");
    vi.stubEnv("CLICOLOR_FORCE", "1");
    expect(legacyAqua("supabase", piped)).toBe("\u001b[36msupabase\u001b[39m");
  });

  it("CLICOLOR_FORCE=0 does not force", () => {
    vi.stubEnv("CLICOLOR_FORCE", "0");
    expect(legacyAqua("supabase", piped)).toBe("supabase");
  });

  it("CI is treated as non-TTY (termenv isTTY)", () => {
    vi.stubEnv("CI", "true");
    expect(legacyAqua("supabase", colorTty)).toBe("supabase");
  });

  it("defaults to gating on stderr when no stream is given", () => {
    // The live TTY-ness of the test process's stderr is environment-dependent,
    // so pin the gate closed via the CI branch: the default-stream form must
    // still come back plain, proving the default threads through the gate.
    vi.stubEnv("CI", "true");
    expect(legacyAqua("supabase")).toBe("supabase");
    expect(legacyBold("text")).toBe("text");
  });
});
