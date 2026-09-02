import { Effect } from "effect";
import { Output } from "../../../../../shared/output/output.service.ts";
import { legacyAqua, legacyYellow } from "../../../../shared/legacy-colors.ts";
import { displayPath } from "../../../../../shared/workers/worker-paths.ts";
import { renderGlamourTable } from "../../../../output/legacy-glamour-table.ts";
import { legacyEmitWorkersPayload, legacyRejectWorkersEnvOutput } from "../workers.output.ts";
import { LegacyPlatformApi } from "../../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import { formatApiSize } from "../../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../../shared/workers/worker-url.ts";
import { listWorkers, type WorkerRecord } from "../../../../../shared/workers/workers-api.ts";
import { legacyDiscoverWorkerNames, legacyLoadWorkersProject } from "../workers.shared.ts";
import { legacyWorkersRun } from "../workers.run.ts";
import type { LegacyWorkersListFlags } from "./list.command.ts";

/**
 * `supabase experimental workers list` — every worker in this project, deployed or not.
 *
 * A union of two sources, because either half alone is misleading: the
 * project's `[workers.*]` entries (scaffolded, maybe never deployed) and what
 * the API reports as deployed (including anything deployed from elsewhere, or
 * from a directory since deleted). A worker in the config with nothing deployed
 * shows as `not deployed`; a deployed worker with no local entry is called out,
 * since pushing it from here would have to guess its runtime.
 *
 * The list endpoint deliberately makes no per-worker backend call, so it
 * carries no live instance tally — the `INSTANCES` column is the declared
 * count from the spec. `status` is where the live tally lives.
 */

/**
 * No URL column. Every worker's URL is the same 40-odd characters of host and
 * prefix with the name on the end, which pushed the table past 130 columns to
 * carry one derivable field — `renderGlamourTable` sizes each column to its
 * widest cell and never wraps. `workers status` renders it, vertically, for the
 * same reason (see `workers.format.ts`), and every machine format still carries
 * `url` per worker.
 */
const HEADERS = ["NAME", "RUNTIME", "SIZE", "STATE", "INSTANCES"] as const;

interface WorkerRow {
  readonly name: string;
  /** Has a `[workers.<name>]` entry in `config.toml`. */
  readonly configured: boolean;
  /** Exists on this machine at all — a config entry, a directory, or both. */
  readonly local: boolean;
  readonly deployed: WorkerRecord | undefined;
  readonly localRuntime: string | undefined;
  readonly url: string | undefined;
}

function stateLabel(row: WorkerRow): string {
  if (row.deployed === undefined) {
    return "not deployed";
  }
  if (row.deployed.deleting === true) {
    return "deleting";
  }
  return row.deployed.buildState;
}

/**
 * The API omits `spec.runtime` only for a context-only build, so for a deployed
 * worker its absence *is* "dockerfile". For one that has never been deployed
 * there is nothing to infer from — `push` would guess from marker files — so say
 * unknown rather than assert a runtime it may not have.
 */
function runtimeLabelFor(row: WorkerRow): string | undefined {
  if (row.deployed !== undefined) {
    return row.deployed.spec.runtime ?? "dockerfile";
  }
  return row.localRuntime;
}

function runtimeLabel(row: WorkerRow): string {
  return runtimeLabelFor(row) ?? "-";
}

/**
 * `api is` / `api, box are` — the subject of both advisories below, which only
 * ever differ in the verb.
 */
function nameList(names: ReadonlyArray<string>): string {
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"}`;
}

function toCells(row: WorkerRow): ReadonlyArray<string> {
  return [
    row.name,
    runtimeLabel(row),
    row.deployed === undefined ? "-" : formatApiSize(row.deployed.spec.size),
    stateLabel(row),
    row.deployed === undefined ? "-" : String(row.deployed.spec.instances),
  ];
}

export const legacyWorkersList = Effect.fn("legacy.experimental.workers.list")(function* (
  flags: LegacyWorkersListFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const settings = yield* LegacyCliSettings;

  yield* legacyWorkersRun(flags.projectRef, ({ projectRef }) =>
    Effect.gen(function* () {
      const project = yield* legacyLoadWorkersProject();

      // Up front, like the rest of the family: this payload always carries a
      // `workers` array, so `-o env` can never encode it, and finding that out at
      // emit time means failing after the fetch has already been paid for.
      yield* legacyRejectWorkersEnvOutput();

      const fetching = yield* output.task("Fetching workers...");
      const deployed = yield* listWorkers(api, projectRef).pipe(
        Effect.tapError(() => fetching.fail()),
      );
      yield* fetching.clear();

      const byName = new Map(deployed.map((worker) => [worker.name, worker]));
      const configuredNames = Object.keys(project.section.workers);
      // Three sources: config entries, deployed workers, and directories under the
      // workers root. The last are deployable — `legacyDiscoverWorkerNames` is the
      // walk a bare `push` does — so the inventory has to show them.
      const discoveredNames = yield* legacyDiscoverWorkerNames(project);
      const names = [...new Set([...configuredNames, ...discoveredNames, ...byName.keys()])].sort();

      const rows: Array<WorkerRow> = names.map((name) => {
        const record = byName.get(name);
        return {
          name,
          configured: configuredNames.includes(name),
          local: configuredNames.includes(name) || discoveredNames.includes(name),
          deployed: record,
          localRuntime: project.section.workers[name]?.runtime,
          url:
            record !== undefined && record.spec.exposure === "public"
              ? workerUrl(projectRef, settings.projectHost, name)
              : undefined,
        };
      });

      const payload = {
        project_ref: projectRef,
        workers: rows.map((row) => ({
          name: row.name,
          configured: row.configured,
          local: row.local,
          deployed: row.deployed !== undefined,
          // Read the same way `runtimeLabel` reads it, so `-o json` and the text
          // table cannot disagree: for a deployed worker an absent `spec.runtime`
          // *means* dockerfile, and falling back to the local config there
          // reported a stale runtime the deployment had moved off.
          runtime: runtimeLabelFor(row),
          size: row.deployed?.spec.size,
          state: stateLabel(row),
          instances: row.deployed?.spec.instances,
          url: row.url,
        })),
      };

      // `-o` is independent of `--output-format`: it leaves `output.format` as
      // `text`, so this has to be checked before the text branch below, not
      // inside the structured one.
      if (yield* legacyEmitWorkersPayload(payload)) {
        return;
      }

      if (rows.length === 0) {
        yield* output.raw(
          `No workers found. Scaffold one with ${legacyAqua("supabase experimental workers new <name>", process.stdout)}.\n`,
        );
        return;
      }

      yield* output.raw(renderGlamourTable([...HEADERS], rows.map(toCells)));

      // Two different problems, and they need different advice. A worker with a
      // local directory but no entry can be pushed — the runtime is the only
      // unknown. One with nothing local at all cannot: `deployOneWorker` checks
      // the source directory *before* inferring a runtime and fails with
      // `WorkerSourceMissingError`, so telling that user about runtime guessing
      // points them at the wrong prerequisite.
      //
      // Both are written the way this shell writes every other heads-up that is
      // not a failure: a yellow `WARNING:` prefix, then the consequence on its own
      // line (`start`'s Docker-on-Windows notice is the same two-line shape). A
      // single long sentence re-flows differently at every terminal width, right
      // under a table that lines its columns up.
      const unconfigured = rows
        .filter((row) => row.deployed !== undefined && !row.configured && row.local)
        .map((row) => row.name);
      if (unconfigured.length > 0) {
        const configDisplay = displayPath(project.projectRoot, project.configPath);
        yield* output.raw(
          `${legacyYellow("WARNING:")} ${nameList(unconfigured)} deployed but not in ${configDisplay}.\n` +
            `Pushing from here would have to guess the runtime.\n`,
          "stderr",
        );
      }

      const remoteOnly = rows
        .filter((row) => row.deployed !== undefined && !row.local)
        .map((row) => row.name);
      if (remoteOnly.length > 0) {
        yield* output.raw(
          `${legacyYellow("WARNING:")} ${nameList(remoteOnly)} deployed with no source in this project.\n` +
            `Scaffold or restore before pushing from here.\n`,
          "stderr",
        );
      }
    }),
  );
});
