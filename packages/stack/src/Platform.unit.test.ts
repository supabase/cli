import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  detectPlatform,
  dockerHostAddress,
  dockerNetworkArgs,
  nativeTargetForPlatform,
} from "./Platform.ts";

describe("detectPlatform", () => {
  it.effect("returns current platform info", () =>
    Effect.gen(function* () {
      const info = yield* detectPlatform;
      expect(info.os).toBeDefined();
      expect(info.arch).toBeDefined();
      expect(["darwin", "linux"]).toContain(info.os);
      expect(["arm64", "x64"]).toContain(info.arch);
    }),
  );
});

describe("nativeTargetForPlatform", () => {
  it("maps darwin-arm64", () => {
    expect(nativeTargetForPlatform({ os: "darwin", arch: "arm64" })).toBe("darwin-arm64");
  });

  it("maps linux-x64", () => {
    expect(nativeTargetForPlatform({ os: "linux", arch: "x64" })).toBe("linux-amd64");
  });

  it("maps linux-arm64", () => {
    expect(nativeTargetForPlatform({ os: "linux", arch: "arm64" })).toBe("linux-arm64");
  });

  it("returns null for unsupported", () => {
    expect(nativeTargetForPlatform({ os: "win32", arch: "x64" })).toBeUndefined();
  });
});

describe("dockerHostAddress", () => {
  it("returns host.docker.internal on linux", () => {
    expect(dockerHostAddress("linux")).toBe("host.docker.internal");
  });

  it("returns host.docker.internal on darwin", () => {
    expect(dockerHostAddress("darwin")).toBe("host.docker.internal");
  });

  it("returns host.docker.internal on win32", () => {
    expect(dockerHostAddress("win32")).toBe("host.docker.internal");
  });
});

describe("dockerNetworkArgs", () => {
  it("returns host gateway and port mapping on linux", () => {
    expect(dockerNetworkArgs("linux", [5432])).toEqual([
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      "5432:5432",
    ]);
  });

  it("returns port mapping on darwin", () => {
    expect(dockerNetworkArgs("darwin", [9999])).toEqual(["-p", "9999:9999"]);
  });

  it("maps multiple ports on non-linux", () => {
    expect(dockerNetworkArgs("darwin", [5432, 9999])).toEqual([
      "-p",
      "5432:5432",
      "-p",
      "9999:9999",
    ]);
  });
});
