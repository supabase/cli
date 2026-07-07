import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installMicroProfile,
  installPodConfOverlay,
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

  it("installs only the pod.conf overlay for default stacks", async () => {
    const pgdata = await fakePgdata();
    await installPodConfOverlay(pgdata);
    await installPodConfOverlay(pgdata);

    const main = await readFile(join(pgdata, "postgresql.conf"), "utf8");
    expect(main).toContain("include_if_exists = 'pod.conf'");
    expect(main).not.toContain("include_if_exists = 'micro.conf'");
    expect(main.match(/include_if_exists = 'pod\.conf'/g)).toHaveLength(1);
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

  it("appends an active include block when only a commented-out include line exists", async () => {
    const pgdata = await fakePgdata();
    const mainPath = join(pgdata, "postgresql.conf");
    await writeFile(mainPath, "# stock conf\nport = 5432\n#include_if_exists = 'micro.conf'\n");
    await installMicroProfile(pgdata);
    const main = await readFile(mainPath, "utf8");
    expect(main.match(/^include_if_exists = 'micro\.conf'$/m)).toHaveLength(1);
    expect(main.match(/^include_if_exists = 'pod\.conf'$/m)).toHaveLength(1);
    // the commented-out line must remain untouched
    expect(main).toContain("#include_if_exists = 'micro.conf'");
  });

  it("parses shared_preload_libraries with flexible spacing and quoting", async () => {
    const pgdata = await fakePgdata();
    await writeFile(join(pgdata, "pod.conf"), "shared_preload_libraries='pg_cron, pg_net'\n");
    expect(await readPreloadLibraries(pgdata)).toEqual(["pg_cron", "pg_net"]);

    await writeFile(join(pgdata, "pod.conf"), '  shared_preload_libraries = "pg_cron,pg_net"\n');
    expect(await readPreloadLibraries(pgdata)).toEqual(["pg_cron", "pg_net"]);
  });

  it("writePreloadLibraries preserves other settings already in pod.conf", async () => {
    const pgdata = await fakePgdata();
    const podPath = join(pgdata, "pod.conf");
    await writeFile(podPath, "other_setting = 'foo'\nshared_preload_libraries = 'pg_cron'\n");
    await writePreloadLibraries(pgdata, ["pg_cron", "pg_net"]);
    const pod = await readFile(podPath, "utf8");
    expect(pod).toContain("other_setting = 'foo'");
    expect(pod).toMatch(/^shared_preload_libraries = 'pg_cron,pg_net'$/m);
    expect(await readPreloadLibraries(pgdata)).toEqual(["pg_cron", "pg_net"]);
  });

  it("writePreloadLibraries appends the line when pod.conf has no existing preload line", async () => {
    const pgdata = await fakePgdata();
    const podPath = join(pgdata, "pod.conf");
    await writeFile(podPath, "other_setting = 'foo'\n");
    await writePreloadLibraries(pgdata, ["pg_net"]);
    const pod = await readFile(podPath, "utf8");
    expect(pod).toContain("other_setting = 'foo'");
    expect(pod).toMatch(/^shared_preload_libraries = 'pg_net'$/m);
  });

  it("writePreloadLibraries creates pod.conf when missing", async () => {
    const pgdata = await fakePgdata();
    await writePreloadLibraries(pgdata, ["pg_cron"]);
    expect(await readPreloadLibraries(pgdata)).toEqual(["pg_cron"]);
  });
});
