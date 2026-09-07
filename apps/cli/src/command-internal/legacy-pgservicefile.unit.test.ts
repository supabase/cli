import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  let tmp: string;
  let path: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pgservice-"));
    path = join(tmp, "pg_service.conf");
    writeFileSync(path, "[prod]\nhost=db.example.com\nport=6543\ndbname=appdb\nuser=alice\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the named section's settings, remapping dbname → database", () => {
    const settings = legacyServiceSettings("prod", path);
    expect(settings).toBeDefined();
    expect(Object.fromEntries(settings!)).toEqual({
      host: "db.example.com",
      port: "6543",
      database: "appdb",
      user: "alice",
    });
  });

  it("returns undefined for an unknown service", () => {
    expect(legacyServiceSettings("missing", path)).toBeUndefined();
  });

  it("returns undefined when the service file is unreadable", () => {
    expect(legacyServiceSettings("prod", join(tmp, "nope.conf"))).toBeUndefined();
  });

  it("returns undefined when the file is malformed", () => {
    writeFileSync(path, "host=orphan\n");
    expect(legacyServiceSettings("prod", path)).toBeUndefined();
  });
});
