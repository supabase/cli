import {
  type ApplyFile,
  type BundleManifest,
  CANONICAL_APPLY_ORDER,
  type PgLineage,
  type ServiceName,
} from "./Manifest.ts";

export interface BundleQuery {
  readonly lineage: PgLineage;
  readonly service: ServiceName;
  /** Exact pinned service version, e.g. "v2.124.2". */
  readonly version: string;
}

export interface BundleHit {
  readonly _tag: "Hit";
  readonly manifest: BundleManifest;
  /** Bundle directory relative to the bundle root, e.g. "pg17/realtime/v2.124.2". */
  readonly dir: string;
  /** Ordered file paths relative to the bundle root. */
  readonly files: ReadonlyArray<ApplyFile>;
}

/**
 * A miss is not an error: hosted projects can pin service versions that were
 * never bundled (`supabase link` writes them to `supabase/.temp/*-version`).
 * The consumer falls back to running the service's own migrate job.
 */
export interface BundleMiss {
  readonly _tag: "Miss";
  readonly query: BundleQuery;
}

export type Resolution = BundleHit | BundleMiss;

export const bundleKey = (query: BundleQuery): string =>
  `${query.lineage}/${query.service}/${query.version}`;

export type BundleIndex = ReadonlyMap<string, BundleManifest>;

export const makeBundleIndex = (manifests: Iterable<BundleManifest>): BundleIndex => {
  const index = new Map<string, BundleManifest>();
  for (const manifest of manifests) {
    index.set(
      bundleKey({
        lineage: manifest.lineage,
        service: manifest.service,
        version: manifest.serviceVersion,
      }),
      manifest,
    );
  }
  return index;
};

export const resolveBundle = (index: BundleIndex, query: BundleQuery): Resolution => {
  const manifest = index.get(bundleKey(query));
  if (manifest === undefined) {
    return { _tag: "Miss", query };
  }
  const dir = bundleKey(query);
  return {
    _tag: "Hit",
    manifest,
    dir,
    files: manifest.apply.map((entry) => ({
      file: `${dir}/${entry.file}`,
      transactionMode: entry.transactionMode,
    })),
  };
};

export interface ServicePins {
  readonly realtime?: string;
  readonly storage?: string;
  readonly auth?: string;
}

export interface ReplayStep {
  readonly service: ServiceName;
  readonly resolution: Resolution;
}

/**
 * Resolve a full replay plan for the given pins in canonical order
 * (realtime → storage → auth — bundles are generated sequentially and only
 * compose in that order). Services without a pin are skipped (disabled in
 * config); a `Miss` step tells the consumer to fall back to that service's
 * container migrate job while still replaying the bundles that resolved.
 *
 * Note: because generation diffs state N−1 → N, a miss for an *earlier*
 * service invalidates static replay of later ones (their bundles assume the
 * predecessor's cluster state). `planReplay` therefore degrades every step
 * from the first miss onward to a miss.
 */
export const planReplay = (
  index: BundleIndex,
  lineage: PgLineage,
  pins: ServicePins,
): ReadonlyArray<ReplayStep> => {
  const steps: Array<ReplayStep> = [];
  let degraded = false;
  for (const service of CANONICAL_APPLY_ORDER) {
    const version = pins[service];
    if (version === undefined) {
      continue;
    }
    const query: BundleQuery = { lineage, service, version };
    const miss: BundleMiss = { _tag: "Miss", query };
    const resolution = degraded ? miss : resolveBundle(index, query);
    if (resolution._tag === "Miss") {
      degraded = true;
    }
    steps.push({ service, resolution });
  }
  return steps;
};
