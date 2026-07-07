import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installMicroProfile,
  readPreloadLibraries,
  writePreloadLibraries,
} from "./pgconf.ts";

async function fakePgdata(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pgconf-test-"));
  await writeFile(join(dir, "postgresql.conf"), "# stock conf\nport = 5432\n");
  return dir;
}

describe("pgconf", () => {
  it("installs micro.conf, pod.conf, and include lines idempotently", async () => {
    const pgdata = await fakePgdata();
    await installMicroProfile(pgdata);
    await installMicroProfile(pgdata); // idempotent
    const main = await readFile(join(pgdata, "postgresql.conf"), "utf8");
    expect(main.match(/include_if_exists = 'micro\.conf'/g)).toHaveLength(1);
    expect(main.match(/include_if_exists = 'pod\.conf'/g)).toHaveLength(1);
    // pod.conf must be included AFTER micro.conf so pod overrides micro
    expect(main.indexOf("micro.conf")).toBeLessThan(main.indexOf("pod.conf"));
    const micro = await readFile(join(pgdata, "micro.conf"), "utf8");
    expect(micro).toContain("shared_buffers = '16MB'");
  });

  it("round-trips preload libraries via pod.conf", async () => {
    const pgdata = await fakePgdata();
    await installMicroProfile(pgdata);
    expect(await readPreloadLibraries(pgdata)).toEqual([]);
    await writePreloadLibraries(pgdata, ["pg_cron"]);
    expect(await readPreloadLibraries(pgdata)).toEqual(["pg_cron"]);
    await writePreloadLibraries(pgdata, ["pg_cron", "pg_net"]);
    expect(await readPreloadLibraries(pgdata)).toEqual(["pg_cron", "pg_net"]);
  });
});
