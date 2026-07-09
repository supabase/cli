import { describe, expect, it } from "vitest";

import {
  LEGACY_START_STARTING_CONTAINERS_MESSAGE,
  LEGACY_START_STARTING_DATABASE_FROM_BACKUP_MESSAGE,
  LEGACY_START_STARTING_DATABASE_MESSAGE,
  LEGACY_START_WAITING_FOR_HEALTH_CHECKS_MESSAGE,
  legacyStartAlreadyRunningMessage,
  legacyStartCompletedMessage,
  legacyStartSecurityNotice,
} from "./start.format.ts";

// The formatters apply Go-parity ANSI styling via `legacy-colors.ts`, which
// no-ops on a real non-TTY stream but the vitest process presents its stderr
// as color-capable. Strip escapes so these assertions target the plain text
// content — matching `status.pretty.unit.test.ts`'s convention.
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

describe("legacyStartAlreadyRunningMessage", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(stripAnsi(legacyStartAlreadyRunningMessage())).toBe(
      "supabase start is already running.\n",
    );
  });
});

describe("LEGACY_START_STARTING_CONTAINERS_MESSAGE", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(LEGACY_START_STARTING_CONTAINERS_MESSAGE).toBe("Starting containers...\n");
  });
});

describe("LEGACY_START_WAITING_FOR_HEALTH_CHECKS_MESSAGE", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(LEGACY_START_WAITING_FOR_HEALTH_CHECKS_MESSAGE).toBe("Waiting for health checks...\n");
  });
});

describe("LEGACY_START_STARTING_DATABASE_MESSAGE", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(LEGACY_START_STARTING_DATABASE_MESSAGE).toBe("Starting database...\n");
  });
});

describe("LEGACY_START_STARTING_DATABASE_FROM_BACKUP_MESSAGE", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(LEGACY_START_STARTING_DATABASE_FROM_BACKUP_MESSAGE).toBe(
      "Starting database from backup...\n",
    );
  });
});

describe("legacyStartCompletedMessage", () => {
  it("matches Go's exact stderr line, with two trailing newlines", () => {
    expect(stripAnsi(legacyStartCompletedMessage())).toBe(
      "Started supabase local development setup.\n\n",
    );
  });
});

describe("legacyStartSecurityNotice", () => {
  it("matches Go's exact 4-line notice plus a trailing blank line", () => {
    expect(stripAnsi(legacyStartSecurityNotice())).toBe(
      "Local dev security notice\n" +
        "All services bind to 0.0.0.0 (network-accessible, not just localhost)\n" +
        "API keys and JWT secrets are shared defaults. Do not use in production\n" +
        "Studio, pgMeta (/pg/*), and analytics have no authentication\n" +
        "\n",
    );
  });

  it("ends with exactly one blank line, matching Go's bare fmt.Fprintln(os.Stderr)", () => {
    const notice = stripAnsi(legacyStartSecurityNotice());
    const lines = notice.split("\n");
    // 4 content lines + 1 trailing blank line from the bare Fprintln + the
    // empty string after the final "\n" that `split` always produces.
    expect(lines).toHaveLength(6);
    expect(lines.at(-2)).toBe("");
    expect(lines.at(-1)).toBe("");
  });
});
