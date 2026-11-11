import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { pgServiceSettings, parseServicefile } from "./pgservicefile.ts";

describe("parseServicefile", () => {
  it("parses [section] key=value groups, ignoring comments and blanks", () => {
    const file = [
      "# global comment",
      "",
      "[prod]",
      "host=db.example.com",
      "port = 6543",
      "dbname=appdb",
      "[staging]",
      "host=staging.example.com",
    ].join("\n");
    const parsed = parseServicefile(file);
    expect(Object.fromEntries(parsed.get("prod")!)).toEqual({
      host: "db.example.com",
      port: "6543",
      dbname: "appdb",
    });
    expect(parsed.get("staging")!.get("host")).toBe("staging.example.com");
  });

  it("splits only on the first '=' so values may contain '='", () => {
    const parsed = parseServicefile("[s]\noptions=-c search_path=public");
    expect(parsed.get("s")!.get("options")).toBe("-c search_path=public");
  });

  it("throws on a key=value line before any section (jackc/pgservicefile parity)", () => {
    expect(() => parseServicefile("host=db.example.com")).toThrow(/not in a section/);
  });

  it("throws on a non key=value line inside a section", () => {
    expect(() => parseServicefile("[s]\nnotavalidline")).toThrow(/unable to parse line/);
  });
});

describe("pgServiceSettings", () => {
  const serviceFile = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "pgservice-" });
    const path = pathService.join(tmp, "pg_service.conf");
    yield* fs.writeFileString(
      path,
      "[prod]\nhost=db.example.com\nport=6543\ndbname=appdb\nuser=alice\n",
    );
    return { fs, pathService, tmp, path };
  });

  it.effect("returns the named section's settings, remapping dbname → database", () =>
    Effect.gen(function* () {
      const { path } = yield* serviceFile;
      const settings = yield* pgServiceSettings("prod", path);
      expect(settings).toBeDefined();
      expect(Object.fromEntries(settings!)).toEqual({
        host: "db.example.com",
        port: "6543",
        database: "appdb",
        user: "alice",
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("returns undefined for an unknown service", () =>
    Effect.gen(function* () {
      const { path } = yield* serviceFile;
      expect(yield* pgServiceSettings("missing", path)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("returns undefined when the service file is unreadable", () =>
    Effect.gen(function* () {
      const { pathService, tmp } = yield* serviceFile;
      expect(yield* pgServiceSettings("prod", pathService.join(tmp, "nope.conf"))).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("returns undefined when the file is malformed", () =>
    Effect.gen(function* () {
      const { fs, path } = yield* serviceFile;
      yield* fs.writeFileString(path, "host=orphan\n");
      expect(yield* pgServiceSettings("prod", path)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
