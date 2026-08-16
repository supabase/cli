import { describe, expect, it } from "vitest";
import { resolvePortIntents } from "./port-intent.ts";

describe("resolvePortIntents", () => {
  it("treats an explicitly configured template default as exact", () => {
    expect(
      resolvePortIntents({
        activeFields: ["apiPort", "dbPort"],
        document: { api: { port: 54321 } },
        valueOrigins: [{ path: ["api", "port"], source: "local" }],
      }),
    ).toEqual([
      {
        field: "apiPort",
        key: "api.port",
        intent: "exact",
        port: 54321,
        source: "local",
      },
      { field: "dbPort", key: "db.port", intent: "automatic", source: "omitted" },
    ]);
  });

  it("retains environment and selected-remote provenance for exact leaves", () => {
    expect(
      resolvePortIntents({
        activeFields: ["dbPort", "studioPort"],
        document: { db: { port: 55432 }, studio: { port: 55433 } },
        valueOrigins: [
          { path: ["db", "port"], source: "environment" },
          { path: ["studio", "port"], source: "remote" },
        ],
      }),
    ).toEqual([
      {
        field: "dbPort",
        key: "db.port",
        intent: "exact",
        port: 55432,
        source: "environment",
      },
      {
        field: "studioPort",
        key: "studio.port",
        intent: "exact",
        port: 55433,
        source: "remote",
      },
    ]);
  });

  it("ignores inactive sticky fields even when the document contains them", () => {
    expect(
      resolvePortIntents({
        activeFields: ["apiPort"],
        document: { api: { port: 55434 }, studio: { port: 55435 } },
      }),
    ).toEqual([
      { field: "apiPort", key: "api.port", intent: "exact", port: 55434, source: "local" },
    ]);
  });
});
