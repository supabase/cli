import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- unit fixture writes a fake artifact tree.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- temp root for the fake artifact tree.
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- join fixture paths.
import { join } from "node:path";

import {
  matchingHostPostgresClient,
  nativeHostClientPathPrepend,
  parsePostgresClientMajor,
  prependHostClientPath,
  rewriteDumpHostForToolContainer,
  toolContainerUsesHostNetwork,
} from "./postgres-client.run.ts";

describe("prependHostClientPath", () => {
  it("prepends a bin directory to PATH", () => {
    expect(prependHostClientPath({ PATH: "/usr/bin" }, "/artifact/bin").PATH).toMatch(
      /^\/artifact\/bin/,
    );
  });
});

describe("nativeHostClientPathPrepend", () => {
  it.effect("returns artifact bin when the extra exists, otherwise undefined", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "native-host-client-"));
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "pg_dump"), "");
      expect(yield* nativeHostClientPathPrepend("pg_dump", { artifactRoot: root })).toBe(bin);
      expect(yield* nativeHostClientPathPrepend("psql", { artifactRoot: root })).toBeUndefined();
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("parsePostgresClientMajor", () => {
  it("reads the PostgreSQL major from client --version output", () => {
    expect(parsePostgresClientMajor("pg_dump (PostgreSQL) 17.4")).toBe(17);
    expect(parsePostgresClientMajor("psql (PostgreSQL) 15.12")).toBe(15);
    expect(parsePostgresClientMajor("pg_dumpall (PostgreSQL) 16.1")).toBe(16);
  });

  it("returns undefined when the version line has no PostgreSQL major", () => {
    expect(parsePostgresClientMajor("pg_prove version 3.36")).toBeUndefined();
    expect(parsePostgresClientMajor("")).toBeUndefined();
  });
});

describe("matchingHostPostgresClient", () => {
  it("accepts a matching psql when pg_dump reports another major", () => {
    expect(matchingHostPostgresClient(16, 17, 17)).toEqual({ kind: "match" });
    expect(matchingHostPostgresClient(17, 16, 17)).toEqual({ kind: "match" });
  });

  it("fails only when neither client matches", () => {
    expect(matchingHostPostgresClient(16, undefined, 17)).toEqual({
      kind: "mismatch",
      command: "pg_dump",
      actual: 16,
    });
    expect(matchingHostPostgresClient(undefined, 15, 17)).toEqual({
      kind: "mismatch",
      command: "psql",
      actual: 15,
    });
    expect(matchingHostPostgresClient(undefined, undefined, 17)).toEqual({
      kind: "mismatch",
      command: "pg_dump",
      actual: undefined,
    });
  });
});

describe("toolContainerUsesHostNetwork", () => {
  it("treats an omitted or Docker host network as the host netns", () => {
    expect(toolContainerUsesHostNetwork(undefined)).toBe(true);
    expect(toolContainerUsesHostNetwork("")).toBe(true);
    expect(toolContainerUsesHostNetwork("host")).toBe(true);
    expect(toolContainerUsesHostNetwork("custom_net")).toBe(false);
  });
});

describe("rewriteDumpHostForToolContainer", () => {
  it("keeps loopback on Linux host networking", () => {
    expect(
      rewriteDumpHostForToolContainer("127.0.0.1", { platform: "linux", usesHostNetwork: true }),
    ).toBe("127.0.0.1");
  });

  it("rewrites loopback when the tool is not on the host netns", () => {
    expect(
      rewriteDumpHostForToolContainer("127.0.0.1", { platform: "linux", usesHostNetwork: false }),
    ).toBe("host.docker.internal");
  });
});
