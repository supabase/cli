import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { legacyServiceSettings, parseLegacyServicefile } from "./legacy-pgservicefile.ts";

describe("parseLegacyServicefile", () => {
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
    const parsed = parseLegacyServicefile(file);
    expect(Object.fromEntries(parsed.get("prod")!)).toEqual({
      host: "db.example.com",
      port: "6543",
      dbname: "appdb",
    });
    expect(parsed.get("staging")!.get("host")).toBe("staging.example.com");
  });

  it("splits only on the first '=' so values may contain '='", () => {
    const parsed = parseLegacyServicefile("[s]\noptions=-c search_path=public");
    expect(parsed.get("s")!.get("options")).toBe("-c search_path=public");
  });

  it("throws on a key=value line before any section (jackc/pgservicefile parity)", () => {
    expect(() => parseLegacyServicefile("host=db.example.com")).toThrow(/not in a section/);
  });

  it("throws on a non key=value line inside a section", () => {
    expect(() => parseLegacyServicefile("[s]\nnotavalidline")).toThrow(/unable to parse line/);
  });
});

describe("legacyServiceSettings", () => {
  const fixture = (
    run: (
      tmp: string,
      servicePath: string,
      files: ReadonlyMap<string, string>,
    ) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* fs.makeTempDirectory({ prefix: "pgservice-" });
      const servicePath = path.join(tmp, "pg_service.conf");
      const files = new Map([
        [servicePath, "[prod]\nhost=db.example.com\nport=6543\ndbname=appdb\nuser=alice\n"],
      ]);
      yield* run(tmp, servicePath, files);
      yield* fs.remove(tmp, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));

  it.effect("returns the named section's settings, remapping dbname → database", () =>
    fixture((_tmp, servicePath, files) =>
      Effect.sync(() => {
        const settings = legacyServiceSettings("prod", servicePath, files);
        expect(settings).toBeDefined();
        expect(Object.fromEntries(settings!)).toEqual({
          host: "db.example.com",
          port: "6543",
          database: "appdb",
          user: "alice",
        });
      }),
    ),
  );

  it.effect("returns undefined for an unknown service", () =>
    fixture((_tmp, servicePath, files) =>
      Effect.sync(() => {
        expect(legacyServiceSettings("missing", servicePath, files)).toBeUndefined();
      }),
    ),
  );

  it.effect("returns undefined when the service file is unreadable", () =>
    fixture((tmp, _servicePath, files) => {
      const missingPath = `${tmp}/nope.conf`;
      return Effect.sync(() => {
        expect(legacyServiceSettings("prod", missingPath, files)).toBeUndefined();
      });
    }),
  );

  it.effect("returns undefined when the file is malformed", () =>
    fixture((_tmp, servicePath, files) => {
      const malformed = new Map(files).set(servicePath, "host=orphan\n");
      return Effect.sync(() => {
        expect(legacyServiceSettings("prod", servicePath, malformed)).toBeUndefined();
      });
    }),
  );
});
