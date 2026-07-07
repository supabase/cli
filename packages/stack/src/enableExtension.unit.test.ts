import { describe, expect, it } from "vitest";
import { planEnableExtension } from "./enableExtension.ts";

describe("planEnableExtension", () => {
  it("no-ops for extensions that do not need preload", () => {
    expect(planEnableExtension("pgvector", [])).toEqual({ action: "none" });
  });
  it("no-ops when already preloaded", () => {
    expect(planEnableExtension("pg_cron", ["pg_cron"])).toEqual({ action: "none" });
  });
  it("appends and restarts otherwise", () => {
    expect(planEnableExtension("pg_cron", ["pg_net"])).toEqual({
      action: "restart",
      libraries: ["pg_net", "pg_cron"],
    });
  });
});
