/**
 * Bundle generator: extracts the exact SQL the service migrate jobs produce
 * into static, versioned artifacts under `bundles/`.
 *
 * Per service, in the CLI's canonical order (realtime → storage → auth):
 * snapshot the catalog, run the service's one-shot migrate job exactly as
 * `db start` does, snapshot again, and persist the pg-delta plan between the
 * two snapshots plus a byte-exact dump of the migration bookkeeping tables.
 * A zero-diff replay against a fresh container verifies that the bundles
 * reproduce sequential service execution.
 *
 * Usage: bun run ./scripts/generate.ts [--lineage pg17] [--postgres-image <tag>]
 *        [--skip-verify] [--dry-run] [--keep]
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serializeCatalog, stringifyCatalogSnapshot } from "@supabase/pg-delta";
import type { ApplyFile, BundleManifest } from "../src/Manifest.ts";
import { CANONICAL_APPLY_ORDER } from "../src/Manifest.ts";
import { migrateJobs } from "../src/generator/jobs.ts";
import { LOCAL_DEV } from "../src/generator/localdev.ts";
import { parsePins, type Pins } from "../src/generator/pins.ts";
import {
  applySqlFile,
  createNetwork,
  dumpTrackingTables,
  execSql,
  type PostgresContainer,
  removeContainer,
  removeNetwork,
  runJob,
  startPostgres,
  waitForInit,
} from "./lib/docker.ts";
import { isZeroDiff, planBundleFiles, snapshotCatalog } from "./lib/pgdelta.ts";

const PACKAGE_DIR = join(import.meta.dir, "..");
const REPO_ROOT = join(PACKAGE_DIR, "..", "..");
const CLI_GO = join(REPO_ROOT, "apps", "cli-go");
const PG_DELTA_VERSION = "1.0.0-alpha.33";

const { values: args } = parseArgs({
  options: {
    lineage: { type: "string", default: "pg17" },
    "postgres-image": { type: "string" },
    "skip-verify": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});

const lineage = args.lineage;
if (lineage !== "pg15" && lineage !== "pg17") {
  throw new Error(`unsupported lineage: ${lineage}`);
}

/** The CLI's pinned images are the single source of truth for what to bundle. */
const resolvePins = async (): Promise<Pins> =>
  parsePins({
    lineage,
    dockerfile: await readFile(join(CLI_GO, "pkg", "config", "templates", "Dockerfile"), "utf8"),
    constantsGo: await readFile(join(CLI_GO, "pkg", "config", "constants.go"), "utf8"),
    postgresImageOverride: args["postgres-image"],
  });

/**
 * The same entrypoint `db start` uses: write the CLI's static templates for
 * the image's own first-init hook, then hand off to the image entrypoint.
 */
const writeInitDir = async (initDir: string): Promise<void> => {
  const template = (name: string) =>
    readFile(join(CLI_GO, "internal", "db", "start", "templates", name), "utf8");
  const initSql = [
    await template("schema.sql"),
    await template("webhook.sql"),
    await template("_supabase.sql"),
  ].join("\n");
  await mkdir(initDir, { recursive: true });
  await writeFile(join(initDir, "postgresql.schema.sql"), initSql);
  await writeFile(
    join(initDir, "entrypoint.sh"),
    `#!/bin/sh
set -eu
cp /baselines-init/postgresql.schema.sql /etc/postgresql.schema.sql
printf '%s' "${LOCAL_DEV.pgsodiumRootKey}" > /etc/postgresql-custom/pgsodium_root.key
exec docker-entrypoint.sh postgres -D /etc/postgresql
`,
  );
};

const postgresEnv = {
  POSTGRES_PASSWORD: LOCAL_DEV.dbPassword,
  POSTGRES_HOST: "/var/run/postgresql",
  JWT_SECRET: LOCAL_DEV.jwtSecret,
  JWT_EXP: String(LOCAL_DEV.jwtExpiry),
};

/** Drop generation-run objects that cannot be static (recorded in the manifest). */
const dropExcluded = async (
  container: PostgresContainer,
  patterns: ReadonlyArray<string>,
): Promise<void> => {
  for (const pattern of patterns) {
    await execSql(
      container,
      `DO $drop$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname || '.' || c.relname ~ '${pattern.replaceAll("'", "''")}'
  LOOP
    EXECUTE format('DROP TABLE %I.%I', r.nspname, r.relname);
  END LOOP;
END $drop$;`,
    );
  }
};

/**
 * pg_dump with per-table `-t` flags skips owned sequences, so emit explicit
 * setval calls for any serial columns of the tracking tables.
 */
const sequenceResets = async (
  container: PostgresContainer,
  tables: ReadonlyArray<string>,
): Promise<string> => {
  const statements: Array<string> = [];
  for (const table of tables) {
    const rows = await execSql(
      container,
      `SELECT pg_get_serial_sequence('${table}', a.attname)
       FROM pg_attribute a
       WHERE a.attrelid = '${table}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND pg_get_serial_sequence('${table}', a.attname) IS NOT NULL;`,
    );
    for (const sequence of rows.split("\n").filter((line) => line.length > 0)) {
      const lastValue = (await execSql(container, `SELECT last_value FROM ${sequence};`)).trim();
      statements.push(`SELECT pg_catalog.setval('${sequence}', ${lastValue}, true);`);
    }
  }
  return statements.length === 0 ? "" : `\n${statements.join("\n")}\n`;
};

interface GeneratedBundle {
  readonly manifest: BundleManifest;
  readonly dir: string;
}

const generateBundles = async (
  container: PostgresContainer,
  network: string,
  pins: Pins,
  bundlesDir: string,
  catalogsDir: string,
) => {
  const jobs = migrateJobs({
    dbHost: container.name,
    images: { realtime: pins.realtime, storage: pins.storage, auth: pins.auth },
  });
  const generated: Array<GeneratedBundle> = [];
  const predecessors: Record<string, string> = {};

  let before = await snapshotCatalog(container.url);
  for (const job of jobs) {
    const version = job.image.split(":").at(-1);
    if (version === undefined) {
      throw new Error(`cannot derive version from image ${job.image}`);
    }
    console.log(`[${job.service}] running migrate job (${job.image})...`);
    await runJob(network, job);
    await dropExcluded(container, job.excluded);

    console.log(`[${job.service}] snapshotting and diffing...`);
    const after = await snapshotCatalog(container.url);
    const planFiles = await planBundleFiles(before, after);

    const dir = join(bundlesDir, lineage, job.service, version);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const apply: Array<ApplyFile> = [];
    for (const file of planFiles) {
      await writeFile(join(dir, file.path), file.sql);
      apply.push({ file: file.path, transactionMode: file.unit.transactionMode });
    }

    // TRUNCATE first: the auth stub in the image pre-seeds bookkeeping rows
    // (7 rows from 2017–2018), so plain INSERTs would conflict on replay.
    const dump = await dumpTrackingTables(container, job.trackingTables);
    const dataSql = `TRUNCATE TABLE ${job.trackingTables.join(", ")};\n\n${dump}${await sequenceResets(container, job.trackingTables)}`;
    await writeFile(join(dir, "data.sql"), dataSql);
    apply.push({ file: "data.sql", transactionMode: "transactional" });

    const manifest: BundleManifest = {
      formatVersion: 1,
      lineage,
      service: job.service,
      serviceVersion: version,
      serviceImage: job.image,
      apply,
      trackingTables: job.trackingTables,
      excluded: job.excluded,
      tuple: {
        postgresImage: pins.pg,
        serviceRole: job.serviceRole,
        env: job.env,
        orioledb: false,
      },
      predecessors: { ...predecessors },
      pgDeltaVersion: PG_DELTA_VERSION,
      generatorVersion: "0.1.0",
    };
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(catalogsDir, `${lineage}-${job.service}-${version}-after.json`),
      stringifyCatalogSnapshot(serializeCatalog(after)),
    );

    generated.push({ manifest, dir });
    predecessors[job.service] = version;
    before = after;
  }
  return { generated, finalCatalog: before };
};

const writeRootManifest = async (bundlesDir: string): Promise<void> => {
  const path = join(bundlesDir, "manifest.json");
  const existing = await readFile(path, "utf8").then(
    (json) => JSON.parse(json) as { lineages?: Array<string> },
    () => ({ lineages: [] as Array<string> }),
  );
  const lineages = [...new Set([...(existing.lineages ?? []), lineage])].sort();
  const root = { formatVersion: 1, applyOrder: CANONICAL_APPLY_ORDER, lineages };
  await writeFile(path, `${JSON.stringify(root, null, 2)}\n`);
};

/**
 * Verification 7a from the RFC: fresh image + all bundles must be
 * catalog-identical to sequential service execution, and the bookkeeping
 * rows must be byte-exact.
 */
const verifyZeroDiffReplay = async (
  pins: Pins,
  network: string,
  initDir: string,
  generated: ReadonlyArray<GeneratedBundle>,
  finalCatalog: Awaited<ReturnType<typeof snapshotCatalog>>,
  referenceData: string,
): Promise<void> => {
  const name = `sql-baselines-verify-${process.pid}`;
  await removeContainer(name);
  const container = await startPostgres({
    name,
    image: pins.pg,
    network,
    initDir,
    env: postgresEnv,
  });
  try {
    await waitForInit(container);
    for (const bundle of generated) {
      console.log(
        `[verify] applying ${bundle.manifest.service}/${bundle.manifest.serviceVersion}...`,
      );
      for (const entry of bundle.manifest.apply) {
        await applySqlFile(container, join(bundle.dir, entry.file));
      }
    }
    console.log("[verify] snapshotting replayed database...");
    const replayed = await snapshotCatalog(container.url);
    if (!(await isZeroDiff(replayed, finalCatalog))) {
      throw new Error(
        "verification failed: replayed catalog differs from sequential service execution",
      );
    }
    const allTables = generated.flatMap((bundle) => bundle.manifest.trackingTables);
    const replayedData = await dumpTrackingTables(container, allTables);
    if (replayedData !== referenceData) {
      throw new Error("verification failed: tracking-table rows are not byte-exact after replay");
    }
    console.log("[verify] zero-diff replay OK, tracking tables byte-exact");
  } finally {
    if (!args.keep) {
      await removeContainer(name);
    }
  }
};

const main = async () => {
  const pins = await resolvePins();
  if (args["dry-run"]) {
    const jobs = migrateJobs({
      dbHost: "<postgres-container>",
      images: { realtime: pins.realtime, storage: pins.storage, auth: pins.auth },
    });
    console.log(JSON.stringify({ lineage, pins, jobs }, null, 2));
    return;
  }
  console.log(`generating ${lineage} bundles against ${pins.pg}`);

  const workDir = join(PACKAGE_DIR, ".work");
  const initDir = join(workDir, "init");
  const catalogsDir = join(workDir, "catalogs");
  const bundlesDir = join(PACKAGE_DIR, "bundles");
  await mkdir(catalogsDir, { recursive: true });
  await writeInitDir(initDir);

  const network = `sql-baselines-${process.pid}`;
  const pgName = `sql-baselines-pg-${process.pid}`;
  await createNetwork(network);
  try {
    const container = await startPostgres({
      name: pgName,
      image: pins.pg,
      network,
      initDir,
      env: postgresEnv,
    });
    console.log(`waiting for ${pins.pg} to initialize...`);
    await waitForInit(container);

    const { generated, finalCatalog } = await generateBundles(
      container,
      network,
      pins,
      bundlesDir,
      catalogsDir,
    );
    await writeRootManifest(bundlesDir);

    const allTables = generated.flatMap((bundle) => bundle.manifest.trackingTables);
    const referenceData = await dumpTrackingTables(container, allTables);

    if (!args.keep) {
      await removeContainer(pgName);
    }
    if (!args["skip-verify"]) {
      await verifyZeroDiffReplay(pins, network, initDir, generated, finalCatalog, referenceData);
    }
    console.log(
      `done: ${generated.map((b) => `${b.manifest.service}/${b.manifest.serviceVersion}`).join(", ")}`,
    );
  } finally {
    if (!args.keep) {
      await removeContainer(pgName);
      await removeNetwork(network);
    }
  }
};

await main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
