import { Effect, Path } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { aqua, yellow } from "../../../../command-internal/colors.ts";
import { displayPath } from "../../../../shared/compute/compute-paths.ts";
import { renderGlamourTable } from "../../../../output/glamour-table.ts";
import { emitComputeMachineOutput, rejectComputeEnvOutput } from "../compute.output.ts";
import { CommandPlatformApi } from "../../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import {
  deployedRuntimeLabel,
  formatApiSize,
} from "../../../../shared/compute/compute-runtimes.ts";
import { computeUrl } from "../../../../shared/compute/compute-url.ts";
import { listCompute, type ComputeRecord } from "../../../../shared/compute/compute-api.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { discoverComputeNames, loadComputeProject } from "../compute.shared.ts";
import type { ComputeListFlags } from "./list.command.ts";

/**
 * `supabase compute list` — every compute in this project, deployed or not.
 *
 * Merges two sources that are each misleading alone: the project's
 * `[compute.*]` entries (maybe never deployed) and what the API reports as
 * deployed (including compute pushed from elsewhere). A configured compute with
 * nothing deployed shows as `not deployed`; a deployed compute with no local
 * entry is called out, since pushing it from here would have to guess its runtime.
 *
 * `INSTANCES` is the declared count from the spec — the list endpoint makes no
 * per-compute call, so it carries no live tally; `status` has that.
 */

/**
 * No URL column: every compute's URL is the same ~40 characters of host and
 * prefix with just the name changing, which would push the table past 130
 * columns for one derivable field. `compute status` renders it vertically for
 * the same reason (see `compute.format.ts`); every machine format still
 * carries `url` per compute.
 */
const HEADERS = ["NAME", "RUNTIME", "SIZE", "STATE", "INSTANCES"] as const;

interface ComputeRow {
  readonly name: string;
  /** Has a `[compute.<name>]` entry in `config.toml`. */
  readonly configured: boolean;
  /** Exists on this machine at all — a config entry, a directory, or both. */
  readonly local: boolean;
  readonly deployed: ComputeRecord | undefined;
  readonly localRuntime: string | undefined;
  readonly url: string | undefined;
}

function stateLabel(row: ComputeRow): string {
  if (row.deployed === undefined) {
    return "not deployed";
  }
  if (row.deployed.deleting === true) {
    return "deleting";
  }
  return row.deployed.buildState;
}

/**
 * An undeployed compute has nothing to infer from, so this reports unknown
 * rather than guessing; a deployed one is named by {@link deployedRuntimeLabel}.
 */
function runtimeLabelFor(row: ComputeRow): string | undefined {
  if (row.deployed !== undefined) {
    return deployedRuntimeLabel({
      apiRuntime: row.deployed.spec.runtime,
      declared: row.localRuntime,
    });
  }
  return row.localRuntime;
}

function runtimeLabel(row: ComputeRow): string {
  return runtimeLabelFor(row) ?? "-";
}

/**
 * `api is` / `api, box are` — the subject of both advisories below, which only
 * ever differ in the verb.
 */
function nameList(names: ReadonlyArray<string>): string {
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"}`;
}

function toCells(row: ComputeRow): ReadonlyArray<string> {
  return [
    row.name,
    runtimeLabel(row),
    row.deployed === undefined ? "-" : formatApiSize(row.deployed.spec.size),
    stateLabel(row),
    row.deployed === undefined ? "-" : String(row.deployed.spec.instances),
  ];
}

export const computeList = Effect.fn("compute.list")(function* (flags: ComputeListFlags) {
  const output = yield* Output;
  const path = yield* Path.Path;
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
    const project = yield* loadComputeProject;

    // Up front, like the rest of the family: this payload always carries a
    // `compute` array, so `-o env` can never encode it, and finding that out at
    // emit time means failing after the fetch has already been paid for.
    yield* rejectComputeEnvOutput();

    const fetching = yield* output.task("Fetching compute...");
    const deployed = yield* listCompute(api, projectRef).pipe(
      Effect.tapError(() => fetching.fail()),
    );
    yield* fetching.clear();

    const byName = new Map(deployed.map((compute) => [compute.name, compute]));
    const configuredNames = Object.keys(project.section.compute);
    // Three sources: config entries, deployed compute, and directories under the
    // compute root. The last are deployable — `discoverComputeNames` is the
    // walk a bare `push` does — so the inventory has to show them.
    const discoveredNames = yield* discoverComputeNames(project);
    const names = [...new Set([...configuredNames, ...discoveredNames, ...byName.keys()])].sort();

    const rows: Array<ComputeRow> = names.map((name) => {
      const record = byName.get(name);
      return {
        name,
        configured: configuredNames.includes(name),
        local: configuredNames.includes(name) || discoveredNames.includes(name),
        deployed: record,
        localRuntime: project.section.compute[name]?.runtime,
        url:
          record !== undefined && record.spec.exposure === "public"
            ? computeUrl(projectRef, settings.projectHost, name)
            : undefined,
      };
    });

    const payload = {
      project_ref: projectRef,
      compute: rows.map((row) => ({
        name: row.name,
        configured: row.configured,
        local: row.local,
        deployed: row.deployed !== undefined,
        // Reads the same way `runtimeLabel` does, so `-o json` and the text
        // table can't disagree: an absent `spec.runtime` on a deployed compute
        // means dockerfile, not a stale local config value.
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
    if (yield* emitComputeMachineOutput(payload)) {
      return;
    }

    if (output.format !== "text") {
      yield* output.success("", payload);
      return;
    }

    if (rows.length === 0) {
      yield* output.raw(
        `No compute found. Scaffold one with ${aqua("supabase compute new <name>", process.stdout)}.\n`,
      );
      return;
    }

    yield* output.raw(renderGlamourTable([...HEADERS], rows.map(toCells)));

    // A local directory with no config entry can still be pushed (only the
    // runtime is unknown); nothing local at all can't — `deployOneCompute`
    // requires a source directory before it infers a runtime, so pointing that
    // case at runtime guessing would name the wrong problem.
    const unconfigured = rows
      .filter((row) => row.deployed !== undefined && !row.configured && row.local)
      .map((row) => row.name);
    if (unconfigured.length > 0) {
      const configDisplay = displayPath(path, project.projectRoot, project.configPath);
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
