import { describe, expect, it } from "vitest";
import {
  buildMicroConf,
  buildPodConf,
  MICRO_POSTGRES_SETTINGS,
  PRELOAD_REQUIRED_EXTENSIONS,
} from "./micro.ts";

describe("micro profile", () => {
  it("contains the normative spec settings", () => {
    const map = new Map(MICRO_POSTGRES_SETTINGS);
    expect(map.get("shared_buffers")).toBe("16MB");
    expect(map.get("jit")).toBe("off");
    expect(map.get("fsync")).toBe("off");
    expect(map.get("wal_level")).toBe("logical");
    expect(map.get("max_slot_wal_keep_size")).toBe("256MB");
    expect(map.get("wal_writer_delay")).toBe("10s");
  });

  it("renders micro.conf as key = 'value' lines", () => {
    const conf = buildMicroConf();
    expect(conf).toContain("shared_buffers = '16MB'");
    expect(conf).toContain("max_connections = '40'");
    expect(conf.endsWith("\n")).toBe(true);
  });

  it("knows which extensions need preload", () => {
    expect(PRELOAD_REQUIRED_EXTENSIONS.has("pg_cron")).toBe(true);
    expect(PRELOAD_REQUIRED_EXTENSIONS.has("pgvector")).toBe(false);
  });

  it("renders pod.conf with shared_preload_libraries", () => {
    expect(buildPodConf(["pg_cron", "pg_net"])).toBe(
      "shared_preload_libraries = 'pg_cron,pg_net'\n",
    );
    expect(buildPodConf([])).toBe("shared_preload_libraries = ''\n");
  });
});
