import { describe, expect, it } from "vitest";

import {
  LEGACY_START_STARTING_DATABASE_FROM_BACKUP_MESSAGE,
  LEGACY_START_STARTING_DATABASE_MESSAGE,
} from "./messages.ts";

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
