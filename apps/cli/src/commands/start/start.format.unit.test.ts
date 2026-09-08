import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import {
  START_STARTING_CONTAINERS_MESSAGE,
  START_WAITING_FOR_HEALTH_CHECKS_MESSAGE,
  startAlreadyRunningMessage,
  startCompletedMessage,
  startSecurityNotice,
} from "./start.format.ts";

describe("startAlreadyRunningMessage", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(stripAnsi(startAlreadyRunningMessage())).toBe("supabase start is already running.\n");
  });
});

describe("START_STARTING_CONTAINERS_MESSAGE", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(START_STARTING_CONTAINERS_MESSAGE).toBe("Starting containers...\n");
  });
});

describe("START_WAITING_FOR_HEALTH_CHECKS_MESSAGE", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(START_WAITING_FOR_HEALTH_CHECKS_MESSAGE).toBe("Waiting for health checks...\n");
  });
});

describe("startCompletedMessage", () => {
  it("matches Go's exact stderr line, with two trailing newlines", () => {
    expect(stripAnsi(startCompletedMessage())).toBe(
      "Started supabase local development setup.\n\n",
    );
  });
});

describe("startSecurityNotice", () => {
  it("matches Go's exact 4-line notice plus a trailing blank line", () => {
    expect(stripAnsi(startSecurityNotice())).toBe(
      "Local dev security notice\n" +
        "All services bind to 0.0.0.0 (network-accessible, not just localhost)\n" +
        "API keys and JWT secrets are shared defaults. Do not use in production\n" +
        "Studio, pgMeta (/pg/*), and analytics have no authentication\n" +
        "\n",
    );
  });

  it("ends with exactly one blank line, matching Go's bare fmt.Fprintln(os.Stderr)", () => {
    const notice = stripAnsi(startSecurityNotice());
    const lines = notice.split("\n");
    // 4 content lines + 1 trailing blank line from the bare Fprintln + the
    // empty string after the final "\n" that `split` always produces.
    expect(lines).toHaveLength(6);
    expect(lines.at(-2)).toBe("");
    expect(lines.at(-1)).toBe("");
  });
});
