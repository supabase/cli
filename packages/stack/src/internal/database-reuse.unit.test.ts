import { describe, expect, it } from "@effect/vitest";
import { unusableDatabaseData } from "./database-reuse.ts";

const stock = "17.11.0.002";
const orioledb = "17.11.0.002-orioledb";

describe("unusableDatabaseData", () => {
  it.each([
    {
      name: "initialized data from another major",
      data: { major: "15", line: "15", initialized: true },
      version: stock,
      reason: "Initialized PostgreSQL data is major 15, but major 17 was requested",
    },
    {
      name: "unfinished data from another major",
      data: { major: "15", line: undefined, initialized: false },
      version: stock,
      reason:
        "PostgreSQL data from an unfinished first start is major 15, but major 17 was requested",
    },
    {
      name: "unrecorded data for OrioleDB",
      data: { major: "17", line: undefined, initialized: false },
      version: orioledb,
      reason: "Unmarked PostgreSQL data cannot be verified as OrioleDB data",
    },
    {
      name: "stock-recorded data for OrioleDB",
      data: { major: "17", line: "17", initialized: false },
      version: orioledb,
      reason:
        "PostgreSQL data from an unfinished first start belongs to release line 17, but 17-orioledb was requested",
    },
    {
      name: "OrioleDB-recorded data for stock",
      data: { major: "17", line: "17-orioledb", initialized: false },
      version: stock,
      reason:
        "PostgreSQL data from an unfinished first start belongs to release line 17-orioledb, but 17 was requested",
    },
  ])("refuses $name", ({ data, version, reason }) => {
    expect(unusableDatabaseData(data, version)).toBe(reason);
  });

  it.each([
    { name: "unrecorded data for stock", line: undefined, version: stock },
    { name: "stock-recorded data for stock", line: "17", version: stock },
    { name: "OrioleDB-recorded data for OrioleDB", line: "17-orioledb", version: orioledb },
  ])("reuses $name", ({ line, version }) => {
    expect(
      unusableDatabaseData({ major: "17", line, initialized: false }, version),
    ).toBeUndefined();
  });
});
