import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalServiceVersionOverrides } from "../../../shared/services/services.shared.ts";
import { legacyServiceContainerIds, localDbContainerId } from "../../shared/legacy-docker-ids.ts";
import { LEGACY_SERVICE_CATALOG } from "../../shared/legacy-service-catalog.ts";
import {
  legacyResolveStartGates,
  legacyResolveStartImagePlan,
  type LegacyStartGates,
} from "./start.gates.ts";
import { LEGACY_START_SERVICES, legacyStartServiceMeta } from "./start.services.ts";

describe("LEGACY_START_SERVICES", () => {
  it("has one row per LEGACY_SERVICE_CATALOG entry, in the catalog's startOrder", () => {
    expect(LEGACY_START_SERVICES).toHaveLength(LEGACY_SERVICE_CATALOG.length);
    expect(LEGACY_START_SERVICES.map((entry) => entry.service)).toEqual(
      LEGACY_SERVICE_CATALOG.map((entry) => entry.service),
    );
    expect(LEGACY_START_SERVICES.map((entry) => entry.startOrder)).toEqual(
      LEGACY_SERVICE_CATALOG.map((entry) => entry.startOrder),
    );
  });

  it("has exactly 13 excludable rows and 1 non-excludable row (Postgres)", () => {
    const excludable = LEGACY_START_SERVICES.filter((entry) => entry.excludeKey !== undefined);
    const nonExcludable = LEGACY_START_SERVICES.filter((entry) => entry.excludeKey === undefined);
    expect(excludable).toHaveLength(13);
    expect(nonExcludable).toHaveLength(1);
    expect(nonExcludable[0]?.service).toBe("postgres");
    expect(nonExcludable[0]?.enabledGate).toBe("always");
  });

  it("carries a non-empty imageConfigField and enabledGate for every entry", () => {
    for (const entry of LEGACY_START_SERVICES) {
      expect(entry.imageConfigField.length).toBeGreaterThan(0);
      expect(entry.enabledGate.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate service, containerSuffix, or imageConfigField values", () => {
    const services = LEGACY_START_SERVICES.map((entry) => entry.service);
    const suffixes = LEGACY_START_SERVICES.map((entry) => entry.containerSuffix);
    const imageConfigFields = LEGACY_START_SERVICES.map((entry) => entry.imageConfigField);

    expect(new Set(services).size).toBe(services.length);
    expect(new Set(suffixes).size).toBe(suffixes.length);
    expect(new Set(imageConfigFields).size).toBe(imageConfigFields.length);
  });

  it("every non-Postgres containerSuffix matches a legacyServiceContainerIds suffix", () => {
    const projectId = "start-services-cross-check";
    const containerIds = legacyServiceContainerIds(projectId);
    const suffixesFromContainerIds = containerIds.map((id) =>
      id.replace(/^supabase_/, "").replace(new RegExp(`_${projectId}$`), ""),
    );

    for (const entry of LEGACY_START_SERVICES) {
      if (entry.service === "postgres") continue;
      expect(suffixesFromContainerIds).toContain(entry.containerSuffix);
    }
  });

  it("Postgres's containerSuffix matches localDbContainerId's suffix", () => {
    const projectId = "start-services-cross-check";
    const postgres = LEGACY_START_SERVICES.find((entry) => entry.service === "postgres");
    expect(postgres?.containerSuffix).toBe("db");
    expect(localDbContainerId(projectId)).toBe(
      `supabase_${postgres?.containerSuffix}_${projectId}`,
    );
  });

  it("notes Vector's dependency on Logflare", () => {
    const vector = LEGACY_START_SERVICES.find((entry) => entry.service === "vector");
    expect(vector?.enabledGate).toBe("analytics.enabled");
    expect(vector?.dependsOn).toEqual(["logflare"]);
  });

  it("notes ImgProxy's dependency on Storage", () => {
    const imgproxy = LEGACY_START_SERVICES.find((entry) => entry.service === "imgproxy");
    expect(imgproxy?.enabledGate).toBe("storage.enabled && storage.image_transformation.enabled");
    expect(imgproxy?.dependsOn).toEqual(["storage"]);
  });

  it("notes Studio's dependency on pg-meta", () => {
    const studio = LEGACY_START_SERVICES.find((entry) => entry.service === "studio");
    expect(studio?.enabledGate).toBe("studio.enabled");
    expect(studio?.dependsOn).toEqual(["pgMeta"]);
  });

  it("gates Kong on !excluded only, with no config field", () => {
    const kong = LEGACY_START_SERVICES.find((entry) => entry.service === "kong");
    expect(kong?.enabledGate).toBe("none");
  });
});

describe("legacyStartServiceMeta", () => {
  it("returns the same metadata as the joined LEGACY_START_SERVICES row", () => {
    const meta = legacyStartServiceMeta("gotrue");
    const entry = LEGACY_START_SERVICES.find((candidate) => candidate.service === "gotrue");
    expect(meta).toEqual({
      imageConfigField: entry?.imageConfigField,
      enabledGate: entry?.enabledGate,
      dependsOn: entry?.dependsOn,
    });
  });

  it("returns undefined for an unknown service key", () => {
    expect(legacyStartServiceMeta("not-a-real-service")).toBeUndefined();
  });
});

/**
 * Cross-check: `start.services.ts`'s `enabledGate` metadata (descriptive
 * only, never read by runtime code — see that module's header) against
 * `start.gates.ts`'s `legacyResolveStartGates` (the REAL, executable gate).
 * The two are hand-maintained separately and can silently drift (e.g. a gate
 * condition changes in `start.gates.ts` without the matching `enabledGate`
 * string being updated) — this mechanically evaluates every `enabledGate`
 * boolean-string expression against a synthetic config and compares it
 * against what `legacyResolveStartGates` actually computes for the SAME
 * config, so a future drift fails loudly here instead of silently.
 */
describe("LEGACY_START_SERVICES enabledGate cross-check against start.gates.ts", () => {
  const decodeConfig = Schema.decodeUnknownSync(CliConfigSchema);

  /** Every `config.toml` boolean atom referenced by a `LEGACY_START_SERVICES` `enabledGate` expression (the `"always"`/`"none"` sentinels aside). */
  const GATE_ATOMS = [
    "analytics.enabled",
    "api.enabled",
    "auth.enabled",
    "local_smtp.enabled",
    "realtime.enabled",
    "storage.enabled",
    "storage.image_transformation.enabled",
    "studio.enabled",
    "db.pooler.enabled",
    "edge_runtime.enabled",
  ] as const;

  /** Builds a `CliConfig` with every {@link GATE_ATOMS} atom explicitly set true/false per `enabled` membership. */
  function configWithEnabled(enabled: ReadonlySet<string>): CliConfig {
    const overrides: Record<string, unknown> = {};
    for (const atom of GATE_ATOMS) {
      const segments = atom.split(".");
      let node = overrides;
      for (let index = 0; index < segments.length - 1; index++) {
        const segment = segments[index]!;
        node[segment] ??= {};
        node = node[segment] as Record<string, unknown>;
      }
      node[segments.at(-1)!] = enabled.has(atom);
    }
    return decodeConfig({ project_id: "start-services-gate-cross-check", ...overrides });
  }

  function getPath(config: CliConfig, path: string): unknown {
    return path
      .split(".")
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
        config,
      );
  }

  /**
   * Evaluates an `enabledGate` string ("x.enabled", "x.enabled && y.enabled",
   * or the `"none"` sentinel) against a synthetic config. Deliberately
   * ignores the `!excluded(...)` factor every real gate also ANDs in — the
   * caller isolates that by resolving with `excludedKeys` empty.
   */
  function evaluateEnabledGate(expr: string, config: CliConfig): boolean {
    if (expr === "none") return true;
    return expr.split("&&").every((atom) => getPath(config, atom.trim()) === true);
  }

  /** Real gates for `config`, with the exclusion factor neutralized (nothing excluded). */
  function realGatesFor(config: CliConfig): LegacyStartGates {
    return legacyResolveStartGates({
      config,
      projectEnvValues: undefined,
      excludedKeys: new Set(),
      document: undefined,
    });
  }

  function expectGatesMatchMetadata(config: CliConfig, label: string) {
    const realGates = realGatesFor(config);
    for (const service of Object.keys(realGates) as ReadonlyArray<keyof LegacyStartGates>) {
      const meta = legacyStartServiceMeta(service);
      expect(meta, `start.services.ts is missing metadata for "${service}"`).toBeDefined();
      const expected = evaluateEnabledGate(meta!.enabledGate, config);
      expect(realGates[service], `${service} (${label})`).toBe(expected);
    }
  }

  it("matches for every gate atom toggled on its own (isolates each atom's effect)", () => {
    for (const atom of GATE_ATOMS) {
      expectGatesMatchMetadata(configWithEnabled(new Set([atom])), `only "${atom}" enabled`);
    }
  });

  it("matches with every gate atom enabled", () => {
    expectGatesMatchMetadata(configWithEnabled(new Set(GATE_ATOMS)), "every atom enabled");
  });

  it("matches with every gate atom disabled", () => {
    expectGatesMatchMetadata(configWithEnabled(new Set()), "every atom disabled");
  });

  it("only omits Postgres (unconditional, handled directly by the caller) from the real gate set", () => {
    const realGates = realGatesFor(configWithEnabled(new Set()));
    const gatedServices = new Set(Object.keys(realGates));
    const ungated = LEGACY_START_SERVICES.filter((entry) => !gatedServices.has(entry.service));
    expect(ungated.map((entry) => entry.service).toSorted()).toEqual(["postgres"]);
  });
});

describe("legacyResolveStartImagePlan under SUPABASE_USE_SLIM_IMAGES", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const allGatesOpen: LegacyStartGates = {
    kong: true,
    gotrue: true,
    mailpit: true,
    realtime: true,
    postgrest: true,
    storage: true,
    imgproxy: true,
    logflare: true,
    vector: true,
    pgMeta: true,
    studio: true,
    supavisor: true,
    edgeRuntime: true,
  };

  const imageFor = (service: string, serviceVersions: LocalServiceVersionOverrides = {}) =>
    legacyResolveStartImagePlan(allGatesOpen, serviceVersions).find(
      (entry) => entry.service === service,
    )?.image;

  it("plans docker.io images while the flag is off", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    expect(imageFor("gotrue")).toBe("supabase/gotrue:v2.196.0");
    expect(imageFor("vector")).toBe("timberio/vector:0.53.0-alpine");
    expect(imageFor("supavisor", { pooler: "2.0.0" })).toBe("supabase/supavisor:2.0.0");
  });

  it("plans slim images when the flag is on, keeping unmapped services on docker.io", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(imageFor("gotrue")).toBe("ghcr.io/supabase/cli/auth:v2.196.0");
    expect(imageFor("logflare")).toBe("ghcr.io/supabase/cli/analytics:v1.50.4");
    expect(imageFor("vector")).toBe("ghcr.io/supabase/cli/vector:0.53.0");
    expect(imageFor("supavisor", { pooler: "2.0.0" })).toBe("ghcr.io/supabase/cli/pooler:v2.0.0");
    expect(imageFor("kong")).toBe("library/kong:2.8.1");
  });
});
