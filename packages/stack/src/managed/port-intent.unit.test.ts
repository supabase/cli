import { describe, expect, it } from "vitest";
import { resolvePortIntents } from "./port-intent.ts";

describe("resolvePortIntents", () => {
  it("treats an explicitly configured template default as exact", () => {
    expect(
      resolvePortIntents({
        activeFields: ["apiPort", "dbPort"],
        document: { api: { port: 54321 } },
      }),
    ).toEqual([
      {
        field: "apiPort",
        key: "api.port",
        intent: "exact",
        port: 54321,
      },
      { field: "dbPort", key: "db.port", intent: "automatic" },
    ]);
  });

  it("ignores inactive sticky fields even when the document contains them", () => {
    expect(
      resolvePortIntents({
        activeFields: ["apiPort"],
        document: { api: { port: 55434 }, studio: { port: 55435 } },
      }),
    ).toEqual([{ field: "apiPort", key: "api.port", intent: "exact", port: 55434 }]);
  });
});
