import { Effect } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { aqua, yellow } from "../../../../command-internal/colors.ts";
import { displayPath } from "../../../../shared/workers/worker-paths.ts";
import { renderGlamourTable } from "../../../../output/glamour-table.ts";
import { emitWorkersMachineOutput, rejectWorkersEnvOutput } from "../workers.output.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { formatApiSize } from "../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../shared/workers/worker-url.ts";
import { listWorkers, type WorkerRecord } from "../../../../shared/workers/workers-api.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { discoverWorkerNames, loadWorkersProject } from "../workers.shared.ts";
import type { WorkersListFlags } from "./list.command.ts";

/**
 * `supabase experimental workers list` — every worker in this project, deployed or not.
 *
 * Merges two sources that are each misleading alone: the project's
 * `[workers.*]` entries (maybe never deployed) and what the API reports as
 * deployed (including workers pushed from elsewhere). A configured worker with
 * nothing deployed shows as `not deployed`; a deployed worker with no local
 * entry is called out, since pushing it from here would have to guess its runtime.
 *
 * `INSTANCES` is the declared count from the spec — the list endpoint makes no
 * per-worker call, so it carries no live tally; `status` has that.
 */

/**
 * No URL column: every worker's URL is the same ~40 characters of host and
 * prefix with just the name changing, which would push the table past 130
 * columns for one derivable field. `workers status` renders it vertically for
 * the same reason (see `workers.format.ts`); every machine format still
 * carries `url` per worker.
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
 * The API omits `spec.runtime` only for a context-only build, so its absence
 * on a deployed worker means "dockerfile". An undeployed worker has nothing to
 * infer from, so this reports unknown rather than guessing.
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

export const workersList = Effect.fn("experimental.workers.list")(function* (
  flags: WorkersListFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const settings = yield* CommandSettings;

  // Resolved here, outside the block below, since caching it is one of that
  // block's own finalizers — everything else that can fail belongs inside so
  // those failures still flush telemetry.
  const projectRef = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* loadWorkersProject();

    // Checked up front: this payload always carries a `workers` array, which
    // `-o env` can never encode, so failing at emit time would mean paying for
    // the fetch first.
    yield* rejectWorkersEnvOutput();

    const fetching = yield* output.task("Fetching workers...");
    const deployed = yield* listWorkers(api, projectRef).pipe(
      Effect.tapError(() => fetching.fail()),
    );
    yield* fetching.clear();

    const byName = new Map(deployed.map((worker) => [worker.name, worker]));
    const configuredNames = Object.keys(project.section.workers);
    // Three sources: config entries, deployed workers, and on-disk directories
    // under the workers root — the last are deployable via a bare `push`, so
    // the inventory must show them too.
    const discoveredNames = yield* discoverWorkerNames(project);
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
        // Reads the same way `runtimeLabel` does, so `-o json` and the text
        // table can't disagree: an absent `spec.runtime` on a deployed worker
        // means dockerfile, not a stale local config value.
        runtime: runtimeLabelFor(row),
        size: row.deployed?.spec.size,
        state: stateLabel(row),
        instances: row.deployed?.spec.instances,
        url: row.url,
      })),
    };

    // `-o` is independent of `--output-format` and leaves `output.format` as
    // `text`, so this must be checked before the text branch, not inside the
    // structured one.
    if (yield* emitWorkersMachineOutput(payload)) {
      return;
    }

    if (output.format !== "text") {
      yield* output.success("", payload);
      return;
    }

    if (rows.length === 0) {
      yield* output.raw(
        `No workers found. Scaffold one with ${aqua("supabase experimental workers new <name>", process.stdout)}.\n`,
      );
      return;
    }

    yield* output.raw(renderGlamourTable([...HEADERS], rows.map(toCells)));

    // A local directory with no config entry can still be pushed (only the
    // runtime is unknown); nothing local at all can't — `deployOneWorker`
    // requires a source directory before it infers a runtime, so pointing that
    // case at runtime guessing would name the wrong problem.
    const unconfigured = rows
      .filter((row) => row.deployed !== undefined && !row.configured && row.local)
      .map((row) => row.name);
    if (unconfigured.length > 0) {
      const configDisplay = displayPath(project.projectRoot, project.configPath);
      yield* output.raw(
        `${yellow("WARNING:")} ${nameList(unconfigured)} deployed but not in ${configDisplay}.\n` +
          `Pushing from here would have to guess the runtime.\n`,
        "stderr",
      );
    }

    const remoteOnly = rows
      .filter((row) => row.deployed !== undefined && !row.local)
      .map((row) => row.name);
    if (remoteOnly.length > 0) {
      yield* output.raw(
        `${yellow("WARNING:")} ${nameList(remoteOnly)} deployed with no source in this project.\n` +
          `Scaffold or restore before pushing from here.\n`,
        "stderr",
      );
    }
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
