import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  detectPlatform,
  dockerHostAddress,
  dockerNetworkArgs,
  postgresAssetName,
  postgrestAssetName,
  authAssetName,
  edgeRuntimeAssetName,
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

describe("postgresAssetName", () => {
  it("maps darwin-arm64", () => {
    expect(postgresAssetName({ os: "darwin", arch: "arm64" })).toBe("darwin-arm64");
  });

  it("maps linux-x64", () => {
    expect(postgresAssetName({ os: "linux", arch: "x64" })).toBe("linux-x64");
  });

  it("maps linux-arm64", () => {
    expect(postgresAssetName({ os: "linux", arch: "arm64" })).toBe("linux-arm64");
  });

  it("returns null for unsupported", () => {
    expect(postgresAssetName({ os: "win32", arch: "x64" })).toBeNull();
  });
});

describe("postgrestAssetName", () => {
  it("maps darwin-arm64 to macos-aarch64", () => {
    expect(postgrestAssetName({ os: "darwin", arch: "arm64" })).toBe("macos-aarch64");
  });

  it("maps linux-x64 to linux-static-x86-64", () => {
    expect(postgrestAssetName({ os: "linux", arch: "x64" })).toBe("linux-static-x86-64");
  });

  it("maps linux-arm64 to ubuntu-aarch64", () => {
    expect(postgrestAssetName({ os: "linux", arch: "arm64" })).toBe("ubuntu-aarch64");
  });

  it("maps win32-x64 to windows-x86-64", () => {
    expect(postgrestAssetName({ os: "win32", arch: "x64" })).toBe("windows-x86-64");
  });

  it("returns null for unsupported", () => {
    expect(postgrestAssetName({ os: "win32", arch: "arm64" })).toBeNull();
  });
});

describe("authAssetName", () => {
  it("maps darwin-arm64 to darwin-arm64", () => {
    expect(authAssetName({ os: "darwin", arch: "arm64" })).toBe("darwin-arm64");
  });

  it("maps linux-x64 to x86", () => {
    expect(authAssetName({ os: "linux", arch: "x64" })).toBe("x86");
  });

  it("maps linux-arm64 to arm64", () => {
    expect(authAssetName({ os: "linux", arch: "arm64" })).toBe("arm64");
  });

  it("returns null for unsupported", () => {
    expect(authAssetName({ os: "darwin", arch: "x64" })).toBeNull();
  });
});

describe("edgeRuntimeAssetName", () => {
  it("maps darwin-arm64 to aarch64-darwin", () => {
    expect(edgeRuntimeAssetName({ os: "darwin", arch: "arm64" })).toBe("aarch64-darwin");
  });

  it("maps linux-x64 to x86_64-linux", () => {
    expect(edgeRuntimeAssetName({ os: "linux", arch: "x64" })).toBe("x86_64-linux");
  });

  it("maps linux-arm64 to aarch64-linux", () => {
    expect(edgeRuntimeAssetName({ os: "linux", arch: "arm64" })).toBe("aarch64-linux");
  });

  it("returns null for unsupported", () => {
    expect(edgeRuntimeAssetName({ os: "win32", arch: "x64" })).toBeNull();
  });
});

describe("dockerHostAddress", () => {
  it("returns 127.0.0.1 on linux", () => {
    expect(dockerHostAddress("linux")).toBe("127.0.0.1");
  });

  it("returns host.docker.internal on darwin", () => {
    expect(dockerHostAddress("darwin")).toBe("host.docker.internal");
  });

  it("returns host.docker.internal on win32", () => {
    expect(dockerHostAddress("win32")).toBe("host.docker.internal");
  });
});

describe("dockerNetworkArgs", () => {
  it("returns --network=host on linux", () => {
    expect(dockerNetworkArgs("linux", [5432])).toEqual(["--network=host"]);
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
