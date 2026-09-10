import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { aqua, yellow } from "../../../command-internal/colors.ts";
import { displayPath } from "../../../shared/compute/compute-paths.ts";
import { renderGlamourTable } from "../../../output/glamour-table.ts";
import { emitComputeMachineOutput, rejectComputeEnvOutput } from "../compute.output.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { formatApiSize } from "../../../shared/compute/compute-runtimes.ts";
import { computeUrl } from "../../../shared/compute/compute-url.ts";
import { listCompute, type ComputeRecord } from "../../../shared/compute/compute-api.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { discoverComputeNames, loadComputeProject } from "../compute.shared.ts";
import type { ComputeListFlags } from "./list.command.ts";

/**
 * `supabase compute list` — every compute in this project, deployed or not.
 *
 * A union of two sources, because either half alone is misleading: the
 * project's `[compute.*]` entries (scaffolded, maybe never deployed) and what
 * the API reports as deployed (including anything deployed from elsewhere, or
 * from a directory since deleted). A compute in the config with nothing deployed
 * shows as `not deployed`; a deployed compute with no local entry is called out,
 * since pushing it from here would have to guess its runtime.
 *
 * The list endpoint deliberately makes no per-compute backend call, so it
 * carries no live instance tally — the `INSTANCES` column is the declared
 * count from the spec. `status` is where the live tally lives.
 */

/**
 * No URL column. Every compute's URL is the same 40-odd characters of host and
 * prefix with the name on the end, which pushed the table past 130 columns to
 * carry one derivable field — `renderGlamourTable` sizes each column to its
 * widest cell and never wraps. `compute status` renders it, vertically, for the
 * same reason (see `compute.format.ts`), and every machine format still carries
 * `url` per compute.
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
 * The API omits `spec.runtime` only for a context-only build, so for a deployed
 * compute its absence *is* "dockerfile". For one that has never been deployed
 * there is nothing to infer from — `push` would guess from marker files — so say
 * unknown rather than assert a runtime it may not have.
 */
function runtimeLabelFor(row: ComputeRow): string | undefined {
  if (row.deployed !== undefined) {
    return row.deployed.spec.runtime ?? "dockerfile";
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
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const settings = yield* CommandSettings;

  // The ref is resolved outside the finalizers because caching it is one of
  // them; everything that can fail on its own — loading `config.toml`,
  // validating the name, resolving the compute — belongs inside, so those
  // failures still flush telemetry. Same shape as `config/push`.
  const projectRef = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const project = yield* loadComputeProject();

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
        // Read the same way `runtimeLabel` reads it, so `-o json` and the text
        // table cannot disagree: for a deployed compute an absent `spec.runtime`
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

    // Two different problems, and they need different advice. A compute with a
    // local directory but no entry can be pushed — the runtime is the only
    // unknown. One with nothing local at all cannot: `deployOneCompute` checks
    // the source directory *before* inferring a runtime and fails with
    // `ComputeSourceMissingError`, so telling that user about runtime guessing
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
