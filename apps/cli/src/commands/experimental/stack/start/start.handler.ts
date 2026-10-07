import { defaultRuntime, postgresVersion } from "@supabase/stack/internal/artifacts";
import {
  connectionEnv,
  renderStackSummary,
  stackConnections,
  stackEndpoints,
  summaryCredentials,
  type StackServiceView,
} from "../stack-summary.ts";
import { gray } from "../../../../command-internal/colors.ts";
import { currentShellPlatform } from "../../../../command-internal/shell-quote.ts";
import { withProjectFunctionsEnv } from "../../../../command-internal/stack-functions-env.ts";
import { statusEnvPointer } from "./start-summary.format.ts";
import {
  automaticRuntimeNotice,
  containerEngineName,
  selectStackRuntime,
  type StackRuntime,
} from "../../../../command-internal/stack-runtime.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { Effect, FileSystem, Fiber, Option, Path, Redacted, Ref } from "effect";
import {
  resolveNativePostgresUser,
  type Observation,
  type PlannedInstance,
  type ServiceCreation,
  type ServiceCreationInput,
  type Stack,
  type StackError,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { MachineErrorContext } from "../../../../shared/output/machine-error-context.service.ts";
import {
  OutputFlag,
  resolveExperimentalWithProjectEnv,
} from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { readDbToml } from "../../../../command-internal/db-config.toml-read.ts";
import { catalogDatabaseServices } from "../../../../command-internal/stack-catalog-setup.ts";
import {
  applyStackWebhooksOnly,
  initializeStackDatabase,
  projectCatalogOverlay,
} from "../../../../command-internal/stack-bootstrap.ts";
import { stackStorageCredentialsFor } from "../../../../command-internal/stack-storage.ts";
import {
  hasConfiguredBuckets,
  SeedConfigLoadError,
  seedBucketsRun,
} from "../../../../command-internal/seed-buckets.ts";
import { loadLocalProjectContext } from "../../../../command-internal/local-project-context.ts";
import {
  loadStackConfig,
  stackEndpointSetting,
  stackMajorVersionSetting,
  type StackEndpointSetting,
} from "../../../../command-internal/stack-config.ts";
import { envOverride } from "../../../../command-internal/local-config-values.ts";
import {
  StackApi,
  stackCapabilityForService,
  StackTargetResolver,
  failedOutcomesDetail,
  mapTargetError,
  rejectStackOutput,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackStartFlags } from "./start.command.ts";
import { StackCommandStartError } from "./start.errors.ts";
import { STACK_START_EXCLUDABLE_CAPABILITIES } from "./start.options.ts";

const validateExclusions = (exclusions: ReadonlyArray<string>) => {
  const supported = new Set<string>(STACK_START_EXCLUDABLE_CAPABILITIES);
  const unknown = exclusions.filter((name) => name !== "database" && !supported.has(name));
  if (unknown.length > 0)
    return Effect.fail(
      new StackCommandStartError({
        reason: "flags",
        message: `Unknown stack capabilities in --exclude: ${unknown.map((name) => JSON.stringify(name)).join(", ")}`,
        suggestion: `Choose from ${STACK_START_EXCLUDABLE_CAPABILITIES.join(", ")}.`,
      }),
    );
  if (exclusions.includes("database"))
    return Effect.fail(
      new StackCommandStartError({
        reason: "flags",
        message: "The database capability cannot be excluded from a stack.",
        suggestion: "Remove database from --exclude.",
      }),
    );
  return Effect.succeed(
    STACK_START_EXCLUDABLE_CAPABILITIES.filter((name) => exclusions.includes(name)),
  );
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * Names the config setting behind a contested public port: the one configured endpoint pinned to
 * that port number. An automatic port, or a port shared by several settings, gets no suggestion.
 */
const portConflictSuggestion = (
  conflict: StackError["conflict"],
  requested: ReadonlyArray<{ readonly service: string; readonly endpoints?: unknown }>,
): string | undefined => {
  if (conflict === undefined) return undefined;
  const settings = new Map<string, StackEndpointSetting>();
  for (const { service, endpoints } of requested) {
    if (!isRecord(endpoints)) continue;
    for (const [name, intent] of Object.entries(endpoints)) {
      const setting = stackEndpointSetting(service, name);
      if (setting !== undefined && isRecord(intent) && intent.port === conflict.port)
        settings.set(setting.envVar, setting);
    }
  }
  const [setting, ...rest] = settings.values();
  return setting === undefined || rest.length > 0
    ? undefined
    : `Set \`${setting.configPath}\` in supabase/config.toml (or ${setting.envVar}) to a free port.`;
};

const stackError = (
  cause: { readonly message: string } & Partial<Pick<StackError, "outcomes" | "conflict">>,
  members: ReadonlyArray<{ readonly id?: string; readonly service: string }> = [],
  requested: ReadonlyArray<{ readonly service: string; readonly endpoints?: unknown }> = [],
) => {
  const detail = failedOutcomesDetail(cause, (id) => {
    const service = members.find((member) => member.id === id)?.service;
    return service === undefined ? id : `${service} (${id})`;
  });
  const suggestion = portConflictSuggestion(cause.conflict, requested);
  return new StackCommandStartError({
    reason: "unknown",
    message: cause.message,
    ...(detail === undefined ? {} : { detail }),
    ...(suggestion === undefined ? {} : { suggestion }),
    cause,
  });
};

// A saved stack keeps its runtime, so only a new stack can switch to native.
const engineUnavailableSuggestion = (
  engine: Exclude<StackRuntime, "native">,
  runtimeInfo: { readonly platform: string; readonly arch: string },
  creating: boolean,
) => {
  const name = containerEngineName(engine);
  const base = `${name} CLI or daemon isn't reachable. Install or start ${name}`;
  return creating &&
    defaultRuntime({ os: runtimeInfo.platform, arch: runtimeInfo.arch }) === "native"
    ? `${base}, or run with --runtime native.`
    : `${base}.`;
};

const stackAcquireError = (
  cause: StackError,
  runtimeContext: {
    readonly selectedRuntime: StackRuntime;
    readonly runtime: { readonly platform: string; readonly arch: string };
    readonly creating: boolean;
  },
) => {
  const base = stackError(cause);
  const { selectedRuntime } = runtimeContext;
  if (cause.reason !== "runtime-unavailable" || selectedRuntime === "native") return base;
  return new StackCommandStartError({
    reason: "runtime",
    message: base.message,
    ...(base.detail === undefined ? {} : { detail: base.detail }),
    suggestion: engineUnavailableSuggestion(
      selectedRuntime,
      runtimeContext.runtime,
      runtimeContext.creating,
    ),
    cause: base.cause,
  });
};

const loadStartConfig = (projectRoot: string, fs: FileSystem.FileSystem, path: Path.Path) =>
  Effect.gen(function* () {
    const config = yield* loadStackConfig(projectRoot);
    const keys = yield* config.keys;
    const toml = yield* readDbToml(fs, path, projectRoot);
    return { config, keys, toml };
  }).pipe(
    Effect.mapError(
      (error) =>
        new StackCommandStartError({
          reason: "invalid-config",
          message: error.message,
          cause: error,
        }),
    ),
  );

const sameKinds = (
  left: ReadonlyArray<{ readonly service: string }>,
  right: ReadonlyArray<{ readonly service: string }>,
): boolean => {
  const leftKinds = new Set(left.map(({ service }) => service));
  const rightKinds = new Set(right.map(({ service }) => service));
  return leftKinds.size === rightKinds.size && [...leftKinds].every((kind) => rightKinds.has(kind));
};

/**
 * Whether this set of requested services would run Studio without the REST API it depends on.
 * The single source of truth for that dependency: the real `--exclude` guard validates against
 * it to reject a request that would otherwise leave Studio stranded.
 */
const studioNeedsRest = (requestedServices: ReadonlyArray<{ readonly service: string }>): boolean =>
  requestedServices.some(({ service }) => service === "studio") &&
  !requestedServices.some(({ service }) => service === "rest");

const endpointPortLabel = (endpoints: unknown, name: string): string => {
  const intent = isRecord(endpoints) ? endpoints[name] : undefined;
  const port = isRecord(intent) ? intent.port : undefined;
  return port === "auto" ? "automatic" : typeof port === "number" ? String(port) : "unset";
};

const databaseVersionOf = (
  creation: ServiceCreation | ServiceCreationInput | undefined,
): string | undefined => (creation?.service === "database" ? creation.config.version : undefined);

const majorVersionOf = (version: string): string => version.split(".")[0] ?? version;

/** Renders a dotted config key as its `config.toml` section/key pair, e.g. `[db] major_version`. */
const formatConfigPath = (path: string): string => {
  const segments = path.split(".");
  const key = segments.pop();
  return `[${segments.join(".")}] ${key}`;
};

/** The display key for a setting: its env var when that's what overrides it, else its config key. */
const settingKeyLabel = (
  setting: StackEndpointSetting,
  projectEnvValues: Readonly<Record<string, string>>,
): string =>
  envOverride(setting.envVar, undefined, projectEnvValues) !== undefined
    ? setting.envVar
    : formatConfigPath(setting.configPath);

/**
 * One incompatible path, reported as the JSON/stream-json error envelope's `stack_changes`
 * entries (contract documented in `SIDE_EFFECTS.md`). `editable` marks whether `key` is a
 * `config.toml` key or env var the user can revert, or plain wording for a catalog-pinned
 * artifact or Postgres build.
 */
interface StructuredSettingChange {
  readonly service: string;
  readonly path: string;
  readonly key: string;
  readonly saved: string;
  readonly requested: string;
  readonly editable: boolean;
}

const describeSettingChange = (
  service: PlannedInstance["service"],
  path: string,
  savedCreation: ServiceCreation | undefined,
  requestedCreation: ServiceCreationInput | undefined,
  projectEnvValues: Readonly<Record<string, string>>,
): StructuredSettingChange => {
  if (service === "database" && path === "config.version") {
    // `postgresVersion` resolves a bare major alias (e.g. "17") to the pinned build the
    // composition plan actually compared, so the saved/requested pair reflects what changed.
    const savedVersion = postgresVersion(databaseVersionOf(savedCreation) ?? "unknown");
    const requestedVersion = postgresVersion(databaseVersionOf(requestedCreation) ?? "unknown");
    const savedMajor = majorVersionOf(savedVersion);
    const requestedMajor = majorVersionOf(requestedVersion);
    // Same major but different pinned build: `major_version` doesn't control this, so reverting
    // it wouldn't fix anything — name the actual (unpinnable) versions instead.
    if (savedMajor === requestedMajor)
      return {
        service,
        path,
        key: "Postgres build",
        saved: savedVersion,
        requested: requestedVersion,
        editable: false,
      };
    return {
      service,
      path,
      key: settingKeyLabel(stackMajorVersionSetting, projectEnvValues),
      saved: savedMajor,
      requested: requestedMajor,
      editable: true,
    };
  }
  const endpointName = path.startsWith("endpoints.") ? path.split(".")[1] : undefined;
  const setting =
    endpointName === undefined ? undefined : stackEndpointSetting(service, endpointName);
  if (endpointName !== undefined && setting !== undefined)
    return {
      service,
      path,
      key: settingKeyLabel(setting, projectEnvValues),
      saved: endpointPortLabel(savedCreation?.endpoints, endpointName),
      requested: endpointPortLabel(requestedCreation?.endpoints, endpointName),
      editable: true,
    };
  // No config.toml key or env var covers this path (e.g. the catalog-pinned artifact `version`):
  // name it plainly instead of implying a setting the user could edit.
  return {
    service,
    path,
    key: path === "version" ? `${service} artifact version` : `${service} ${path}`,
    saved: path === "version" ? (savedCreation?.version ?? "unknown") : "changed",
    requested: path === "version" ? (requestedCreation?.version ?? "unknown") : "changed",
    editable: false,
  };
};

/** Every incompatible path across every rejected saved member, as one structured list. */
const incompatibleSettingChanges = (
  planned: ReadonlyArray<PlannedInstance>,
  savedConfigById: ReadonlyMap<string, ServiceCreation>,
  requested: ReadonlyArray<ServiceCreationInput>,
  projectEnvValues: Readonly<Record<string, string>>,
): ReadonlyArray<StructuredSettingChange> =>
  planned
    .filter((entry) => entry.member && entry.change === "incompatible")
    .flatMap((entry) =>
      // Narrowed by the filter above; `Extract` isn't inferred through `.filter`.
      entry.change === "incompatible"
        ? entry.paths.map((path) =>
            describeSettingChange(
              entry.service,
              path,
              savedConfigById.get(entry.id),
              requested.find((creation) => creation.service === entry.service),
              projectEnvValues,
            ),
          )
        : [],
    );

/** One deduplicated text line per distinct setting change (shared API port lines collapse to one). */
const settingChangeLines = (
  changes: ReadonlyArray<StructuredSettingChange>,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const lines: Array<string> = [];
  for (const change of changes) {
    const line = `${change.key}: saved ${change.saved}, requested ${change.requested}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
};

const dedupe = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

/**
 * The exact `supabase stack destroy` invocation that recreates this stack. Always targets
 * `--stack-id`: a `--stack <name>` destroy re-resolves the name against the caller's current
 * `--workdir`, which can point at a different project's stack of the same name. Omits `--yes` on
 * purpose, since destroying deletes local database data (details in `SIDE_EFFECTS.md`).
 */
const destroyCommandFor = (id: string): string => `supabase stack destroy --stack-id ${id}`;

/** The revert clause for the editable keys among a rejection's changes, or `undefined` for none. */
const revertAdvice = (editableKeys: ReadonlyArray<string>): string | undefined =>
  editableKeys.length === 0
    ? undefined
    : editableKeys.length === 1
      ? `Revert ${editableKeys[0]} to its saved value`
      : "Revert the settings listed to their saved values";

/** Rejects every saved member whose endpoints or artifact versions the request would change. */
const incompatibleChange = (
  planned: ReadonlyArray<PlannedInstance>,
  savedConfigById: ReadonlyMap<string, ServiceCreation>,
  requested: ReadonlyArray<ServiceCreationInput>,
  projectEnvValues: Readonly<Record<string, string>>,
  stackIdentity: { readonly id: string; readonly name?: string },
):
  | {
      readonly error: StackCommandStartError;
      readonly changes: ReadonlyArray<StructuredSettingChange>;
      readonly command: string;
    }
  | undefined => {
  const changes = incompatibleSettingChanges(planned, savedConfigById, requested, projectEnvValues);
  if (changes.length === 0) return undefined;
  const lines = settingChangeLines(changes);
  const command = destroyCommandFor(stackIdentity.id);
  const nameNote = stackIdentity.name === undefined ? "" : ` (stack ${stackIdentity.name})`;
  const revert = revertAdvice(
    dedupe(changes.filter((change) => change.editable).map(({ key }) => key)),
  );
  const nonEditable = dedupe(changes.filter((change) => !change.editable).map(({ key }) => key));
  const destroyClause = `\`${command}\`${nameNote} to recreate the stack — this permanently deletes its local database data.`;
  // A non-editable change blocks start whatever else changed, so destroy is the only way out.
  const suggestion =
    nonEditable.length > 0 || revert === undefined
      ? `This CLI release starts a different ${nonEditable.join(" and ")} than the saved stack. Run ${destroyClause}`
      : `${revert} to keep the stack and its data, or run ${destroyClause}`;
  return {
    changes,
    command,
    error: new StackCommandStartError({
      reason: "invalid-config",
      message: `The saved stack cannot adopt these changes: ${lines.join("; ")}`,
      suggestion,
    }),
  };
};

const selectedCreations = (
  creations: ReadonlyArray<ServiceCreationInput>,
  exclusions: ReadonlyArray<string>,
) =>
  creations.filter((creation) => {
    const capability = stackCapabilityForService(creation.service);
    return !exclusions.includes(capability);
  });

const isServing = (status: Pick<Observation, "lifecycle" | "health">) =>
  status.lifecycle === "running" && status.health === "healthy";

const startReport = (
  stack: Pick<Stack, "composition">,
  instances: ReadonlyArray<{
    readonly id: string;
    readonly service: ServiceCreation["service"];
    readonly status: Effect.Effect<Observation, StackError>;
  }>,
) =>
  Effect.gen(function* () {
    const { members } = yield* stack.composition.describe;
    const activation = new Map(members.map((member) => [member.id, member.activation]));
    const views = yield* Effect.forEach(instances, (instance) =>
      instance.status.pipe(
        Effect.map((observation): StackServiceView => ({
          service: instance.service,
          observation,
          activation: activation.get(instance.id),
        })),
      ),
    );
    return { views, endpoints: stackEndpoints(views) };
  }).pipe(Effect.mapError(stackError));

/** Starts the selected managed stack and applies the local database overlays. */
export const stackStart = Effect.fn("experimental.stack.start")(function* (flags: StackStartFlags) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const resolver = yield* StackTargetResolver;
    const stackApi = yield* StackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* rejectStackOutput(outputFlag).pipe(
      Effect.mapError(mapTargetError((props) => new StackCommandStartError(props))),
    );
    const exclusions = yield* validateExclusions(flags.exclude);
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(mapTargetError((props) => new StackCommandStartError(props))));
    const target = yield* resolver
      .resolve({
        projectRoot: settings.workdir,
        ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
        ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
        runtime: flags.runtime,
      })
      .pipe(Effect.mapError(mapTargetError((props) => new StackCommandStartError(props))));
    const runtime = yield* RuntimeInfo;
    const selectedRuntime = yield* selectStackRuntime(target.runtime).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandStartError({
            reason: error.reason === "native-unsupported" ? "flags" : "runtime",
            message: error.message,
            suggestion: error.suggestion,
            cause: error,
          }),
      ),
    );
    const postgresUser = yield* resolveNativePostgresUser(selectedRuntime);
    const ensurePostgresUser =
      postgresUser._tag === "Unavailable"
        ? new StackCommandStartError({
            reason: "lifecycle",
            message: postgresUser.message,
            suggestion: postgresUser.suggestion,
          })
        : postgresUser._tag === "StepDown"
          ? output.info(postgresUser.message)
          : Effect.void;
    const configBeforeCreate =
      target.id === undefined ? yield* loadStartConfig(target.projectRoot, fs, path) : undefined;
    if (target.id === undefined) yield* ensurePostgresUser;
    const stateRoot = path.join(settings.supabaseHome, "stacks");
    const cacheRoot = path.join(settings.supabaseHome, "cache", "stack");
    const startupComplete = yield* Ref.make(false);
    const stack = yield* Effect.acquireRelease(
      target.id === undefined
        ? stackApi.create({
            projectRoot: target.projectRoot,
            stateRoot,
            cacheRoot,
            runtime: selectedRuntime,
            startOwner: true,
            ...(target.name === undefined ? {} : { name: target.name }),
          })
        : stackApi.open({ id: target.id, stateRoot, cacheRoot, startOwner: true }),
      (stack) =>
        Ref.get(startupComplete).pipe(
          Effect.flatMap((complete) =>
            complete || target.hostRunning
              ? Effect.void
              : stack.stop.pipe(
                  Effect.catch((error) =>
                    output.raw(
                      `Failed to stop stack host ${stack.id}: ${error.message}. Run supabase stack stop --stack-id ${stack.id} to stop it.\n`,
                      "stderr",
                    ),
                  ),
                ),
          ),
        ),
    ).pipe(
      Effect.mapError((cause) =>
        stackAcquireError(cause, { selectedRuntime, runtime, creating: target.id === undefined }),
      ),
    );
    const statusPointer = statusEnvPointer(
      {
        explicitWorkdir: settings.explicitWorkdir,
        projectRoot: target.projectRoot,
        ...(Option.isSome(flags.stack) ? { stack: flags.stack.value } : {}),
        ...(Option.isSome(flags.stackId) ? { stackId: stack.id } : {}),
      },
      currentShellPlatform(),
    );
    const reportReady = (report: Effect.Success<ReturnType<typeof startReport>>, message: string) =>
      Effect.gen(function* () {
        const credentials = yield* summaryCredentials(stack.credentials.get, output.warn);
        const connections = stackConnections(
          report.views.filter(({ activation }) => activation !== undefined),
        );
        const env = connectionEnv(connections, credentials);
        if (output.format !== "text")
          return yield* output.success(message, {
            id: stack.id,
            runtime: selectedRuntime,
            endpoints: report.endpoints,
            lazy_services: report.views
              .filter(({ activation }) => activation === "lazy")
              .map(({ service }) => service),
            env,
          });
        if (message.length > 0) yield* output.success(message);
        yield* output.raw(
          `\n${renderStackSummary(report.views, credentials)}\n${gray(`Runtime: ${selectedRuntime}`, process.stdout)}\nRun ${statusPointer} to export these values as environment variables.\n`,
        );
      });
    const runtimeNotice =
      target.id === undefined ? automaticRuntimeNotice(target.runtime, selectedRuntime) : undefined;
    if (runtimeNotice !== undefined) yield* output.info(runtimeNotice);
    const existingServices = yield* stack.services.list.pipe(Effect.mapError(stackError));
    const composition = yield* stack.composition.describe.pipe(Effect.mapError(stackError));
    const currentInstances = yield* Effect.forEach(composition.members, ({ id }) =>
      stack.services.get(id).pipe(Effect.mapError(stackError)),
    );
    const currentStatuses = yield* Effect.forEach(currentInstances, (instance) =>
      instance.status.pipe(Effect.mapError(stackError)),
    );
    const primaryDatabase = currentInstances.find((instance) => instance.service === "database");
    const databaseStatus = currentStatuses.find(({ id }) => id === primaryDatabase?.id);
    const fullyStarted =
      databaseStatus !== undefined &&
      isServing(databaseStatus) &&
      currentStatuses.every((status) =>
        status.lifecycle === "running"
          ? isServing(status)
          : status.lifecycle !== "starting" && status.wakeEnabled,
      );
    if (fullyStarted) {
      yield* Effect.annotateCurrentSpan({ "stack.path": "already-running" });
      yield* Ref.set(startupComplete, true);
      yield* reportReady(
        yield* startReport(stack, currentInstances),
        "Stack is already running with its current services. Run `supabase stack stop`, then `supabase stack start` to apply configuration or service-selection changes.",
      );
      return stack.id;
    }
    const resumable =
      primaryDatabase !== undefined &&
      databaseStatus?.lifecycle === "running" &&
      currentStatuses.every(
        ({ lifecycle, wakeEnabled }) =>
          lifecycle === "running" || lifecycle === "starting" || wakeEnabled,
      );
    if (resumable) {
      yield* Effect.annotateCurrentSpan({
        "stack.path": "resume",
        "stack.service_count": currentInstances.length,
      });
      yield* output.info(
        "Resuming the saved stack services. Run `supabase stack stop`, then `supabase stack start` to apply configuration or service-selection changes.",
      );
      const starting = yield* output.task("Starting local Supabase stack...");
      yield* primaryDatabase.ready.pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
      yield* stack.composition.start.pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError((error) => stackError(error, currentInstances)),
      );
      // Composition start awaits only eager members; lazy members that are up must be ready too.
      const active = new Set(
        currentStatuses
          .filter(({ lifecycle }) => lifecycle === "running" || lifecycle === "starting")
          .map(({ id }) => id),
      );
      yield* Effect.forEach(
        currentInstances.filter(({ id }) => active.has(id)),
        (instance) => instance.ready,
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
      yield* Ref.set(startupComplete, true);
      const report = yield* startReport(stack, currentInstances).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
      );
      yield* starting.succeed("Stack is ready.");
      yield* reportReady(report, "");
      return stack.id;
    }
    const fullyStopped = currentStatuses.every(
      ({ lifecycle, wakeEnabled }) => lifecycle === "stopped" && !wakeEnabled,
    );
    if (!fullyStopped)
      return yield* new StackCommandStartError({
        reason: "lifecycle",
        message: "The stack is in a partial lifecycle state",
        suggestion: "Run supabase stack stop, then supabase stack start to recover the stack.",
      });
    if (target.id !== undefined) yield* ensurePostgresUser;
    const shadowDatabase =
      composition.members.length === 0
        ? existingServices.find((instance) => instance.service === "database")
        : undefined;
    if (shadowDatabase !== undefined)
      return yield* new StackCommandStartError({
        reason: "lifecycle",
        message: "A standalone database exists outside the saved stack composition",
        suggestion: "Destroy the standalone database before starting this stack.",
      });
    const { config, keys, toml } =
      configBeforeCreate ?? (yield* loadStartConfig(target.projectRoot, fs, path));
    const creations = yield* config.creations(stack.id).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandStartError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const requested = yield* Effect.forEach(
      selectedCreations(creations, exclusions),
      withProjectFunctionsEnv,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new StackCommandStartError({ reason: "invalid-config", message: cause.message, cause }),
      ),
    );
    if (studioNeedsRest(requested))
      return yield* new StackCommandStartError({
        reason: "flags",
        message: "Studio cannot be started without the REST API capability",
        suggestion: "Remove --exclude rest or also exclude studio.",
      });
    const requestedDatabase = requested.find((creation) => creation.service === "database");
    const savedCredentials = yield* stack.credentials.get.pipe(Effect.mapError(stackError));
    if (requestedDatabase?.service === "database" && savedCredentials !== undefined) {
      const rootKey = requestedDatabase.config.rootKey;
      if (rootKey !== undefined && Redacted.value(rootKey) !== savedCredentials.postgresRootKey)
        return yield* new StackCommandStartError({
          reason: "invalid-config",
          message: "The configured Postgres root key conflicts with the saved stack credentials",
        });
    }
    if (requested.some(({ service }) => service === "storage"))
      yield* fs
        .makeDirectory(
          path.join(target.projectRoot, "supabase", ".temp", "stack-uploads", stack.id),
          {
            recursive: true,
          },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new StackCommandStartError({
                reason: "invalid-config",
                message: `Unable to create the Storage uploads directory: ${cause.message}`,
                cause,
              }),
          ),
        );
    if (requested.some(({ service }) => service === "functions"))
      yield* fs
        .makeDirectory(path.join(target.projectRoot, "supabase", "functions"), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new StackCommandStartError({
                reason: "invalid-config",
                message: `Unable to create the Functions directory: ${cause.message}`,
                cause,
              }),
          ),
        );
    if (requested.some(({ service }) => service === "studio"))
      yield* fs
        .makeDirectory(path.join(target.projectRoot, "supabase", "snippets"), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new StackCommandStartError({
                reason: "invalid-config",
                message: `Unable to create the Studio snippets directory: ${cause.message}`,
                cause,
              }),
          ),
        );
    const initialComposition = composition.members.length === 0;
    const serviceKindsChanged = !sameKinds(currentInstances, requested);
    const planned = yield* stack.composition.plan(requested).pipe(Effect.mapError(stackError));
    const stackIdentity = {
      id: stack.id,
      ...(target.name === undefined ? {} : { name: target.name }),
    };
    const savedConfigById = new Map(currentStatuses.map(({ id, config: saved }) => [id, saved]));
    const rejected = incompatibleChange(
      planned,
      savedConfigById,
      requested,
      config.projectEnvValues,
      stackIdentity,
    );
    if (rejected !== undefined) {
      const machineErrorContext = yield* Effect.serviceOption(MachineErrorContext);
      if (Option.isSome(machineErrorContext))
        yield* machineErrorContext.value.set({
          stack_changes: rejected.changes,
          recreate_command: rejected.command,
        });
      return yield* rejected.error;
    }
    const reuseIds: Array<string> = planned.filter(({ member }) => member).map(({ id }) => id);
    for (const creation of requested) {
      if (currentInstances.some(({ service }) => service === creation.service)) continue;
      const candidates = [];
      for (const candidate of planned) {
        if (
          candidate.member ||
          candidate.service !== creation.service ||
          candidate.change === "incompatible"
        )
          continue;
        const status = yield* stack.services.get(candidate.id).pipe(
          Effect.flatMap((instance) => instance.status),
          Effect.map(Option.some),
          Effect.catchTag("StackError", () => Effect.succeed(Option.none())),
        );
        if (
          Option.isSome(status) &&
          status.value.lifecycle === "stopped" &&
          !status.value.wakeEnabled
        )
          candidates.push(candidate);
      }
      if (candidates.length > 1)
        return yield* new StackCommandStartError({
          reason: "lifecycle",
          message: `Multiple stopped ${creation.service} instances match this stack configuration`,
          suggestion: "Remove the unused stack service, then retry.",
        });
      const candidate = candidates[0];
      if (candidate !== undefined) reuseIds.push(candidate.id);
    }
    yield* Effect.annotateCurrentSpan({
      "stack.path": "start",
      "stack.service_count": requested.length,
      "stack.initial_composition": initialComposition,
      "stack.service_kinds_changed": serviceKindsChanged,
    });
    const starting = yield* output.task("Starting local Supabase stack...");
    const members = yield* stack.composition
      .supabase(requested, {
        keys,
        eager: flags.eager,
        ...(reuseIds.length === 0 ? {} : { reuseIds }),
      })
      .pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError((error) => stackError(error, requested, requested)),
      );
    if (initialComposition) {
      const existingIds = new Set(existingServices.map(({ id }) => id));
      const owned = members.filter(({ id }) => !existingIds.has(id));
      const cleanupInitialSafe = Effect.gen(function* () {
        yield* stack.composition.stop;
        yield* stack.composition.configure({ members: [], dependencies: [] });
        yield* Effect.forEach(
          owned,
          (instance) =>
            instance.destroy.pipe(
              Effect.catch((error) =>
                output.raw(
                  `Failed to remove initial ${instance.service} instance ${instance.id}: ${error.message}. Run supabase stack destroy --stack-id ${stack.id} before retrying.\n`,
                  "stderr",
                ),
              ),
            ),
          { discard: true },
        );
      }).pipe(
        Effect.catch((error) =>
          output.raw(
            `Failed to clean up initial stack ${stack.id}: ${error.message}. Run supabase stack destroy --stack-id ${stack.id} before retrying.\n`,
            "stderr",
          ),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Ref.get(startupComplete).pipe(
          Effect.flatMap((complete) => (complete ? Effect.void : cleanupInitialSafe)),
        ),
      );
    }
    const database = members.find((instance) => instance.service === "database");
    if (database === undefined)
      return yield* new StackCommandStartError({
        reason: "invalid-config",
        message: "The stack composition has no database service",
      });
    const preparation =
      flags.preparation === "background"
        ? yield* Effect.forEach(
            members,
            (member) => member.prepare.pipe(Effect.mapError(stackError), Effect.forkScoped),
            { concurrency: "unbounded" },
          )
        : [];
    yield* database.start.pipe(
      Effect.tapError((error) => starting.fail(error.message)),
      Effect.mapError(stackError),
    );
    yield* database.ready.pipe(
      Effect.tapError((error) => starting.fail(error.message)),
      Effect.mapError(stackError),
    );
    const stackCredentials = yield* stack.credentials.get.pipe(Effect.mapError(stackError));
    if (stackCredentials === undefined)
      return yield* new StackCommandStartError({
        reason: "invalid-config",
        message: "The stack has no saved credentials",
      });
    if (initialComposition || serviceKindsChanged) {
      yield* Effect.annotateCurrentSpan({ "stack.migrations_applied": true });
      const migrations = initialComposition
        ? {
            workdir: target.projectRoot,
            toml,
            experimental: yield* resolveExperimentalWithProjectEnv({ ...toml.projectEnv }),
          }
        : undefined;
      yield* initializeStackDatabase({
        target: { stack, database, databaseServices: catalogDatabaseServices(requested) },
        overlay: projectCatalogOverlay(toml, target.projectRoot),
        ...(migrations === undefined ? {} : { migrations }),
      }).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
    }
    if (!initialComposition)
      yield* applyStackWebhooksOnly(database, toml.webhooksEnabled).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
    if (initialComposition) {
      const storage = members.find((instance) => instance.service === "storage");
      if (storage !== undefined) {
        const context = yield* loadLocalProjectContext(
          target.projectRoot,
          (message) => new SeedConfigLoadError({ message }),
        );
        if (hasConfiguredBuckets(context.config)) {
          yield* Effect.annotateCurrentSpan({ "stack.storage_seeded": true });
          yield* storage.start.pipe(
            Effect.tapError((error) => starting.fail(error.message)),
            Effect.mapError(stackError),
          );
          yield* storage.ready.pipe(
            Effect.tapError((error) => starting.fail(error.message)),
            Effect.mapError(stackError),
          );
          const credentials = yield* stackStorageCredentialsFor(
            storage,
            stackCredentials.serviceRoleKey,
          ).pipe(Effect.mapError(stackError));
          yield* seedBucketsRun({
            projectRef: "",
            emitSummary: false,
            interactive: false,
            yes: true,
            // Non-interactive prompts here would fake a `[Y/n]` question nobody answers.
            promptless: true,
            credentials,
            resolvedConfig: { config: context.config, document: context.loaded?.document },
            projectEnvValues: toml.projectEnv,
            workdir: target.projectRoot,
          }).pipe(Effect.mapError(stackError));
        }
      }
    }
    yield* stack.composition.start.pipe(
      Effect.tapError((error) => starting.fail(error.message)),
      Effect.mapError((error) => stackError(error, members, requested)),
    );
    yield* Effect.forEach(preparation, (fiber) => Fiber.join(fiber));
    yield* Ref.set(startupComplete, true);
    const report = yield* startReport(stack, members).pipe(
      Effect.tapError((error) => starting.fail(error.message)),
    );
    yield* starting.succeed("Stack is ready.");
    yield* reportReady(report, "");
    return stack.id;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
