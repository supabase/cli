import { describe, expect, it } from "vitest";

import {
  START_STARTING_DATABASE_FROM_BACKUP_MESSAGE,
  START_STARTING_DATABASE_MESSAGE,
} from "./messages.ts";

describe("START_STARTING_DATABASE_MESSAGE", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(START_STARTING_DATABASE_MESSAGE).toBe("Starting database...\n");
  });
});

describe("START_STARTING_DATABASE_FROM_BACKUP_MESSAGE", () => {
  it("matches Go's exact stderr line, with a single trailing newline", () => {
    expect(START_STARTING_DATABASE_FROM_BACKUP_MESSAGE).toBe("Starting database from backup...\n");
  });
});
