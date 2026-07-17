import { describe, expect, it } from "vitest";
import { toStartStackConfig, withServiceVersions } from "./stack-config.ts";

describe("toStartStackConfig", () => {
  it("sets the requested startup mode", () => {
    expect(toStartStackConfig([], "auto")).toMatchObject({ mode: "auto" });
    expect(toStartStackConfig([], "docker")).toMatchObject({ mode: "docker" });
    expect(toStartStackConfig([], "native")).toMatchObject({ mode: "native" });
  });

  it("dedupes excluded services when building stack config", () => {
    expect(toStartStackConfig(["auth", "auth"], "auto").services).not.toContain("auth");
    expect(toStartStackConfig(["auth", "postgrest"], "auto").services).toEqual(
      expect.not.arrayContaining(["auth", "postgrest"]),
    );
  });
});

describe("withServiceVersions", () => {
  it("injects linked service versions without re-enabling excluded services", () => {
    expect(
      withServiceVersions(toStartStackConfig([], "auto"), {
        postgres: "17.6.1.090",
        postgrest: "14.5",
        auth: "2.187.0",
        storage: "1.39.2",
        realtime: "2.78.10",
      }),
    ).toMatchObject({
      postgres: { version: "17.6.1.090" },
      postgrest: { version: "14.5" },
      auth: { version: "2.187.0" },
      storage: { version: "1.39.2" },
      realtime: { version: "2.78.10" },
    });

    const excluded = withServiceVersions(toStartStackConfig(["auth", "storage"], "auto"), {
      postgres: "17.6.1.090",
      auth: "2.187.0",
      storage: "1.39.2",
    });
    expect(excluded).toMatchObject({
      postgres: { version: "17.6.1.090" },
    });
    expect(excluded.auth).toBeUndefined();
    expect(excluded.storage).toBeUndefined();
  });
});
