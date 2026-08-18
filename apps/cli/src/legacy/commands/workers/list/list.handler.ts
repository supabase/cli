import { Effect } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { legacyEmitWorkersMachineOutput } from "../workers.output.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { formatApiSize } from "../../../../shared/workers/worker-runtimes.ts";
import { workerUrl } from "../../../../shared/workers/worker-url.ts";
import { listWorkers, type WorkerRecord } from "../../../../shared/workers/workers-api.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyDiscoverWorkerNames, legacyLoadWorkersProject } from "../workers.shared.ts";
import type { LegacyWorkersListFlags } from "./list.command.ts";

/**
 * `supabase workers list` — every worker in this project, deployed or not.
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

const HEADERS = ["NAME", "RUNTIME", "SIZE", "STATE", "INSTANCES", "URL"] as const;

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

function toCells(row: WorkerRow): ReadonlyArray<string> {
  return [
    row.name,
    runtimeLabel(row),
    row.deployed === undefined ? "-" : formatApiSize(row.deployed.spec.size),
    stateLabel(row),
    row.deployed === undefined ? "-" : String(row.deployed.spec.instances),
    row.url ?? "-",
  ];
}

export const legacyWorkersList = Effect.fn("legacy.workers.list")(function* (
  flags: LegacyWorkersListFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const cliConfig = yield* LegacyCliConfig;

  // The ref is resolved outside the finalizers because caching it is one of
  // them; everything that can fail on its own — loading `config.toml`,
  // validating the name, resolving the worker — belongs inside, so those
  // failures still flush telemetry. Same shape as `config/push`.
  const projectRef = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* legacyLoadWorkersProject();

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
            ? workerUrl(projectRef, cliConfig.projectHost, name)
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
    if (yield* legacyEmitWorkersMachineOutput(payload)) {
      return;
    }

    if (output.format !== "text") {
      yield* output.success("", payload);
      return;
    }

    if (rows.length === 0) {
      yield* output.raw("No workers found. Scaffold one with supabase workers new <name>.\n");
      return;
    }

    yield* output.raw(renderGlamourTable([...HEADERS], rows.map(toCells)));

    // Deployed *and* unconfigured: a bare local directory is also unconfigured,
    // and has not been deployed at all.
    const orphans = rows
      .filter((row) => row.deployed !== undefined && !row.configured)
      .map((row) => row.name);
    if (orphans.length > 0) {
      yield* output.raw(
        `${orphans.join(", ")} ${
          orphans.length === 1 ? "is" : "are"
        } deployed but absent from supabase/config.toml: pushing from here would have to guess the runtime.\n`,
        "stderr",
      );
    }
  }).pipe(
    Effect.ensuring(linkedProjectCache.cache(projectRef)),
    Effect.ensuring(telemetryState.flush),
  );
});
