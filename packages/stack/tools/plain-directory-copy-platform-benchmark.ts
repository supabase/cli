import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { makeDatabaseSnapshots } from "../src/services/DatabaseSnapshot.ts";
import layout from "./plain-copy-fixture-layout.json";

type Dataset = keyof typeof layout;
interface Layout {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<readonly [string, number]>;
}
type Manifest = Record<string, string>;

const fixtureLayout = layout as unknown as Record<Dataset, Layout>;

interface Sample {
  readonly dataset: Dataset;
  readonly repetition: number;
  readonly warmup: boolean;
  readonly saveMs: number;
  readonly restoreMs: number;
  readonly totalMs: number;
  readonly verifiedFiles: number;
}

const argument = (name: string, fallback: string | undefined = undefined) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const requiredArgument = (name: string) => {
  const value = argument(name);
  if (value === undefined) throw new Error(`Missing --${name}=...`);
  return value;
};

const datasetArgument = requiredArgument("dataset");
const dataset: Dataset =
  datasetArgument === "small"
    ? "small"
    : datasetArgument === "large"
      ? "large"
      : (() => {
          throw new Error(`Invalid dataset: ${datasetArgument}`);
        })();

const repetitions = Number(argument("reps", "5"));
const warmups = Number(argument("warmups", "1"));
const root = requiredArgument("root");
const output = requiredArgument("out");
const filesystem = argument("filesystem", "unknown");
const filesystemProofPath = argument("filesystem-proof");

if (!Number.isInteger(repetitions) || repetitions < 1 || !Number.isInteger(warmups) || warmups < 0)
  throw new Error("Invalid repetitions or warmup count");

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const bytesFor = (relative: string, size: number) => {
  if (relative === "PG_VERSION") return Buffer.from("17\n");
  return Buffer.alloc(size, createHash("sha256").update(relative).digest()[0]);
};

const fixture = async (directory: string, definition: Layout): Promise<Manifest> => {
  const data = `${directory}/data`;
  await mkdir(data, { recursive: true });
  for (const relative of definition.directories)
    await mkdir(`${data}/${relative}`, { recursive: true });
  const expected: Manifest = {};
  for (const [relative, size] of definition.files) {
    const bytes = bytesFor(relative, size);
    await writeFile(`${data}/${relative}`, bytes);
    expected[relative] = digest(bytes);
  }
  await writeFile(
    `${directory}/.supabase-database-ready.json`,
    '{"version":"17.6.1.173","runtime":"native","profile":"supabase"}',
  );
  return expected;
};

const manifest = async (directory: string, expected: Manifest): Promise<Manifest> => {
  const actual: Manifest = {};
  for (const relative of Object.keys(expected))
    actual[relative] = digest(await readFile(`${directory}/${relative}`));
  return actual;
};

const assertEqual = (left: unknown, right: unknown, message: string) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(message);
};

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const filesystemProof = filesystemProofPath
  ? await readFile(filesystemProofPath, "utf8").catch(() => "")
  : "";

const cloneProbe = async (probeRoot: string) => {
  if (platform() === "win32")
    return { attempted: false, supported: false, error: "DirectoryCopy skips CoW flags on win32" };
  const source = `${probeRoot}/clone-probe-source`;
  const target = `${probeRoot}/clone-probe-target`;
  await writeFile(source, Buffer.alloc(1024 * 1024, 7));
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
    return { attempted: true, supported: true, error: "" };
  } catch (cause) {
    return { attempted: true, supported: false, error: String(cause) };
  } finally {
    await rm(source, { force: true });
    await rm(target, { force: true });
  }
};

const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);

const started = performance.now();
await mkdir(root, { recursive: true });
const runRoot = `${root}/plain-copy-${dataset}`;
await rm(runRoot, { recursive: true, force: true });
await mkdir(runRoot, { recursive: true });
const sourceRoot = `${runRoot}/source`;
const targetRoot = `${runRoot}/target`;
const cacheRoot = `${runRoot}/cache`;
const expected = await fixture(sourceRoot, fixtureLayout[dataset]);
const fixtureManifestDigest = digest(
  Buffer.from(
    JSON.stringify(Object.entries(expected).sort(([left], [right]) => left.localeCompare(right))),
  ),
);
const probe = await cloneProbe(runRoot);
if (probe.supported)
  throw new Error("Forced clone probe succeeded; this environment cannot measure plain fallback");
await mkdir(targetRoot, { recursive: true });
const sourceSnapshots = await run(
  makeDatabaseSnapshots({
    instanceRoot: sourceRoot,
    cacheRoot,
    runtime: "native",
    version: "17.6.1.173",
    stackId: "plain-copy-platform",
    instanceId: `source-${dataset}`,
  }).pipe(Effect.provide(NodeServices.layer)),
);
const targetSnapshots = await run(
  makeDatabaseSnapshots({
    instanceRoot: targetRoot,
    cacheRoot,
    runtime: "native",
    version: "17.6.1.173",
    stackId: "plain-copy-platform",
    instanceId: `target-${dataset}`,
  }).pipe(Effect.provide(NodeServices.layer)),
);

const samples: Array<Sample> = [];
const key = `plain-copy-${dataset}`;
for (let repetition = 0; repetition < warmups + repetitions; repetition++) {
  await rm(`${targetRoot}/data`, { recursive: true, force: true });
  await rm(`${targetRoot}/.supabase-database-ready.json`, { force: true });
  const saveStart = performance.now();
  await run(sourceSnapshots.saveSnapshot(key));
  const saveMs = performance.now() - saveStart;
  const restoreStart = performance.now();
  const restored = await run(targetSnapshots.restoreSnapshot(key));
  const restoreMs = performance.now() - restoreStart;
  if (!restored) throw new Error("Snapshot restore unexpectedly missed");

  const restoredManifest = await manifest(`${targetRoot}/data`, expected);
  assertEqual(restoredManifest, expected, `Restored fixture differs on repetition ${repetition}`);
  const first = Object.keys(expected)[0];
  if (first === undefined) throw new Error("Fixture is empty");
  await writeFile(`${targetRoot}/data/${first}`, "target mutation");
  assertEqual(
    digest(await readFile(`${sourceRoot}/data/${first}`)),
    expected[first],
    "Target mutation changed the source fixture",
  );
  assertEqual(
    await manifest(`${sourceRoot}/data`, expected),
    expected,
    "Source fixture changed during the benchmark",
  );
  const entry = (await readdir(`${cacheRoot}/stack-database-snapshots/entries`)).find((name) =>
    /^[a-f0-9]{64}$/u.test(name),
  );
  if (entry === undefined) throw new Error("Snapshot cache entry is missing");
  assertEqual(
    await manifest(`${cacheRoot}/stack-database-snapshots/entries/${entry}/data`, expected),
    expected,
    "Target mutation changed the cached snapshot",
  );

  if (repetition >= warmups)
    samples.push({
      dataset,
      repetition: repetition - warmups,
      warmup: false,
      saveMs,
      restoreMs,
      totalMs: saveMs + restoreMs,
      verifiedFiles: Object.keys(expected).length,
    });
}

const values = (name: "saveMs" | "restoreMs" | "totalMs") => samples.map((sample) => sample[name]);
const report = {
  fixture: {
    kind: "synthetic deterministic bytes from real PostgreSQL tree manifest",
    dataset,
    sourceBytes: fixtureLayout[dataset].files.reduce((sum, file) => sum + file[1], 0),
    sourceFiles: Object.keys(expected).length,
    sourceDirectories: fixtureLayout[dataset].directories.length,
    pgVersion: "17",
    payloadSource: "real PostgreSQL data-directory layout; no original contents copied",
    manifestDigest: fixtureManifestDigest,
  },
  mechanism: probe.supported
    ? "copyFile clone succeeded on probe filesystem"
    : "ordinary-copy fallback",
  filesystem,
  filesystemProof,
  cloneProbe: probe,
  machine: {
    platform: platform(),
    arch: arch(),
    kernel: release(),
    cpu: cpus()[0]?.model,
    bun: process.versions.bun,
    node: process.versions.node,
  },
  repetitions,
  warmups,
  elapsedSetupMs: performance.now() - started,
  samples,
  mediansMs: {
    save: median(values("saveMs")),
    restore: median(values("restoreMs")),
    total: median(values("totalMs")),
  },
  rangesMs: {
    save: [Math.min(...values("saveMs")), Math.max(...values("saveMs"))],
    restore: [Math.min(...values("restoreMs")), Math.max(...values("restoreMs"))],
    total: [Math.min(...values("totalMs")), Math.max(...values("totalMs"))],
  },
  verification: {
    sourceManifestDigest: fixtureManifestDigest,
    cacheManifestCheckedOutsideTiming: true,
    targetManifestCheckedOutsideTiming: true,
    mutationIsolationCheckedOutsideTiming: true,
  },
};
await mkdir(output.split(/[\\/]/u).slice(0, -1).join("/") || ".", { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
await rm(runRoot, { recursive: true, force: true });
