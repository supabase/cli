import type { ServiceName } from "./ServiceName.ts";

export type ManagedStackContractArea =
  | "api-boundary"
  | "bootstrap"
  | "credentials"
  | "identity"
  | "native-qualification"
  | "ports"
  | "reclamation"
  | "runtime";

export type ManagedStackContractJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<ManagedStackContractJson>
  | { readonly [key: string]: ManagedStackContractJson };

export type ManagedStackContractFact =
  | {
      readonly kind: "workspace";
      readonly mode: "bare-worktree" | "git" | "linked-worktree" | "ordinary-folder";
      readonly path: string;
      readonly canonicalPath?: string;
      readonly previousPath?: string;
      readonly previousPathAccess?: "inaccessible" | "missing" | "reachable";
      readonly copiedFrom?: string;
      readonly clonedFrom?: string;
    }
  | {
      readonly kind: "git-state";
      readonly workspacePath: string;
      readonly commonDirectory: string;
      readonly gitDirectory: string;
      readonly head: "branch" | "detached";
      readonly branch?: string;
      readonly commit: string;
      readonly trackedIdentityMarker?: boolean;
    }
  | {
      readonly kind: "identity-claim";
      readonly scope: "checkout" | "context" | "project";
      readonly id: string;
      readonly path?: string;
      readonly owner?: string;
      readonly status: "absent" | "ambiguous" | "duplicate" | "exact";
    }
  | {
      readonly kind: "identity-transition";
      readonly operation:
        | "branch-commit"
        | "branch-copy"
        | "branch-delete-recreate"
        | "branch-rebase"
        | "branch-rename"
        | "branch-reset"
        | "checkout-copy"
        | "checkout-move"
        | "clone"
        | "detached-commit"
        | "folder-to-git"
        | "ref-replacement"
        | "symlink-alias";
      readonly from?: string;
      readonly to?: string;
      readonly originalExists?: boolean;
    }
  | {
      readonly kind: "concurrent-operation";
      readonly operation: "create-stack";
      readonly target: string;
      readonly contenders: number;
    }
  | {
      readonly kind: "operation-result";
      readonly operation: "legacy-bootstrap";
      readonly stackId: string;
      readonly outcome: "rolled-back";
    }
  | {
      readonly kind: "stack-names";
      readonly names: ReadonlyArray<string>;
    }
  | {
      readonly kind: "checkout";
      readonly path: string;
      readonly projectId: string;
      readonly checkoutId: string;
    }
  | {
      readonly kind: "branch";
      readonly name: string;
      readonly contextId: string;
      readonly checkedOut: boolean;
    }
  | {
      readonly kind: "stack";
      readonly name: string;
      readonly stackId: string;
      readonly contextId: string;
      readonly lifecycle: "running" | "stopped";
      readonly orphaned?: boolean;
    }
  | {
      readonly kind: "config-port";
      readonly key: string;
      readonly intent: "automatic" | "exact";
      readonly value?: number;
      readonly previousValue?: number;
      readonly source?: "environment" | "local" | "omitted" | "remote";
    }
  | {
      readonly kind: "port-assignment";
      readonly stackId: string;
      readonly key: string;
      readonly port: number;
      readonly intent: "automatic" | "exact";
    }
  | {
      readonly kind: "occupied-port";
      readonly port: number;
      readonly owner: "managed-stack";
      readonly ownerId: string;
    }
  | {
      readonly kind: "occupied-port";
      readonly port: number;
      readonly owner: "external-process" | "legacy-stack";
      readonly ownerId?: string;
    }
  | {
      readonly kind: "persisted-runtime";
      readonly stackId: string;
      readonly runtime: "docker" | "native";
    }
  | {
      readonly kind: "runtime-request";
      readonly source: "cli" | "config" | "default" | "managed-api";
      readonly runtime: "auto" | "docker" | "native";
    }
  | {
      readonly kind: "runtime-availability";
      readonly runtime: "docker" | "native";
      readonly available: boolean;
      readonly reason?: string;
    }
  | {
      readonly kind: "native-qualification";
      readonly platform: string;
      readonly qualifiedServices: ReadonlyArray<ServiceName>;
      readonly failedServices: ReadonlyArray<ServiceName>;
    }
  | {
      readonly kind: "managed-target";
      readonly stackId: string;
      readonly exists: boolean;
    }
  | {
      readonly kind: "managed-record";
      readonly stackId: string;
      readonly status: "active" | "orphaned" | "tombstoned";
    }
  | {
      readonly kind: "legacy-state";
      readonly lifecycle: "absent" | "running" | "stopped";
      readonly database: "absent" | "compatible" | "incompatible";
      readonly storage: "absent" | "compatible" | "incompatible";
      readonly credentials: "absent" | "compatible" | "incompatible";
    }
  | {
      readonly kind: "credential-state";
      readonly source: "configured" | "legacy" | "local-default" | "persisted";
      readonly valuesId: string;
      readonly previousValuesId?: string;
    }
  | {
      readonly kind: "identity-marker";
      readonly markerId: string;
      readonly workspacePath: string;
      readonly projectId: string;
      readonly checkoutId: string;
      readonly contextId: string;
      readonly tracked: false;
    }
  | {
      readonly kind: "direct-stack-options";
      readonly roots: "explicit" | "omitted";
    }
  | {
      readonly kind: "managed-api-options";
      readonly stateRoot: "default" | "isolated";
      readonly stateRootPath?: string;
      readonly repository: "in-memory" | "injected" | "persistent-adapter";
      readonly repositoryId?: string;
      readonly runtime: "bun" | "node";
    };

export interface ManagedStackContractOutput {
  readonly human?: {
    readonly summary: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly recovery?: ReadonlyArray<string>;
  };
  readonly json?: Readonly<Record<string, ManagedStackContractJson>>;
  readonly api?: Readonly<Record<string, ManagedStackContractJson>>;
}

type ManagedStackContractWrite =
  | {
      readonly target: "git-config";
      readonly operation: "create" | "update";
      readonly id: string;
      readonly scope: "common" | "worktree";
      readonly owner?: string;
    }
  | {
      readonly target: "identity-marker";
      readonly operation: "create" | "update";
      readonly id: string;
      readonly storage: "project-local-untracked";
      readonly workspacePath: string;
      readonly projectId: string;
      readonly checkoutId: string;
      readonly contextId: string;
    }
  | {
      readonly target: "ephemeral-state";
      readonly operation: "create";
      readonly id: string;
    }
  | {
      readonly target: "managed-state";
      readonly operation: "copy" | "create" | "delete" | "update";
      readonly id: string;
    }
  | {
      readonly target: "registry";
      readonly operation: "delete" | "publish" | "tombstone" | "update";
      readonly id: string;
    }
  | {
      readonly target: "runtime-state";
      readonly operation: "delete" | "start" | "update";
      readonly id: string;
    };

export interface ManagedStackContractEffects {
  readonly writes: ReadonlyArray<ManagedStackContractWrite>;
  readonly runtimeEffects: ReadonlyArray<{
    readonly operation: "copy" | "delete" | "start" | "stop";
    readonly stackId: string;
  }>;
  readonly output: ManagedStackContractOutput;
}

export interface ManagedStackContractExpectation extends ManagedStackContractEffects {
  readonly outcome: "create" | "delete" | "error" | "no-op" | "report" | "reuse" | "update";
  readonly selection?: {
    readonly projectId: string;
    readonly checkoutId: string;
    readonly contextId: string;
    readonly stackId: string;
    readonly stackName: string;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly recovery: ReadonlyArray<string>;
  };
  readonly warning?: {
    readonly code: string;
    readonly message: string;
    readonly recovery: ReadonlyArray<string>;
  };
  readonly details?: Readonly<Record<string, ManagedStackContractJson>>;
}

export type ManagedStackContractAction =
  | {
      readonly interface: "cli";
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
    }
  | {
      readonly interface: "git";
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
    }
  | {
      readonly interface: "managed-api";
      readonly method: string;
      readonly input: Readonly<Record<string, ManagedStackContractJson>>;
    }
  | {
      readonly interface: "stack-api";
      readonly method: string;
      readonly input: Readonly<Record<string, ManagedStackContractJson>>;
    };

export interface ManagedStackContractScenario {
  readonly id: string;
  readonly title: string;
  readonly area: ManagedStackContractArea;
  readonly given: ReadonlyArray<ManagedStackContractFact>;
  readonly when: ManagedStackContractAction;
  readonly expected: ManagedStackContractExpectation;
}

export interface ManagedNativeServiceMatrix {
  readonly targetPlatforms: ReadonlyArray<string>;
  readonly unsupportedPlatforms: ReadonlyArray<string>;
  readonly services: ReadonlyArray<readonly [service: ServiceName, version: string]>;
}

export const managedNativeServiceMatrix: ManagedNativeServiceMatrix = {
  targetPlatforms: ["darwin-arm64", "linux-amd64", "linux-arm64"],
  unsupportedPlatforms: ["darwin-x64", "windows-amd64", "windows-arm64"],
  services: [
    ["postgres", "17.6.1.160"],
    ["postgrest", "v14.16"],
    ["auth", "v2.195.0"],
    ["edge-runtime", "v1.74.3"],
    ["realtime", "v2.124.1"],
    ["storage", "v1.68.9"],
    ["pgmeta", "v0.96.8"],
    ["studio", "2026.08.03-sha-022b374"],
    ["analytics", "v1.50.1"],
    ["pooler", "v2.9.10"],
    ["mailpit", "v1.30.2"],
    ["vector", "v0.53.0"],
    ["imgproxy", "v3.27.2"],
  ],
};

const defineManagedStackContractFixtures = <
  const Fixtures extends ReadonlyArray<ManagedStackContractScenario>,
>(
  fixtures: Fixtures,
): Fixtures => fixtures;

const isManagedStackContractRecord = (
  value: ManagedStackContractJson | undefined,
): value is Readonly<Record<string, ManagedStackContractJson>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const managedStackContractJsonEquals = (
  left: ManagedStackContractJson,
  right: ManagedStackContractJson,
): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => managedStackContractJsonEquals(value, right[index] ?? null))
    );
  }
  if (isManagedStackContractRecord(left) && isManagedStackContractRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          right[key] !== undefined &&
          managedStackContractJsonEquals(left[key] ?? null, right[key]),
      )
    );
  }
  return false;
};

const managedStackContractStringSetEquals = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
};

const isManagedStartAction = (action: ManagedStackContractAction): boolean =>
  (action.interface === "cli" && action.argv[0] === "start") ||
  (action.interface === "managed-api" &&
    (action.method === "startStack" ||
      action.method === "startConcurrently" ||
      action.input.operation === "start"));

export const validateManagedStackContractFixtures = (
  fixtures: ReadonlyArray<ManagedStackContractScenario>,
): ReadonlyArray<string> => {
  const errors: Array<string> = [];
  const ids = new Set<string>();
  const nativeServices = managedNativeServiceMatrix.services.map(([service]) => service);
  const nativeServiceSet = new Set<ServiceName>(nativeServices);
  const fixturesById = new Map(fixtures.map((scenario) => [scenario.id, scenario]));

  for (const scenario of fixtures) {
    if (ids.has(scenario.id)) {
      errors.push(`${scenario.id}: duplicate scenario ID`);
    }
    ids.add(scenario.id);

    if (!scenario.id.startsWith(`${scenario.area}.`)) {
      errors.push(`${scenario.id}: ID must start with ${scenario.area}.`);
    }
    if (scenario.title.trim().length === 0) {
      errors.push(`${scenario.id}: title is required`);
    }
    if (scenario.given.length === 0) {
      errors.push(`${scenario.id}: at least one given fact is required`);
    }

    if (scenario.when.interface === "cli" || scenario.when.interface === "git") {
      if (scenario.when.argv.length === 0) {
        errors.push(`${scenario.id}: argv must contain a public command`);
      }
      if (scenario.when.cwd.trim().length === 0) {
        errors.push(`${scenario.id}: cwd is required for command scenarios`);
      }
    } else {
      if (scenario.when.method.trim().length === 0) {
        errors.push(`${scenario.id}: public API method is required`);
      }
    }

    if (scenario.when.interface === "managed-api") {
      const managedMethods = new Set([
        "createManagedStackService",
        "preflightNative",
        "resolvePortIntents",
        "resolveStack",
        "resolveStackNames",
        "runPortableContract",
        "runRepositoryContract",
        "startConcurrently",
        "startStack",
      ]);
      const { input, method } = scenario.when;
      const allowedInputKeys: Readonly<Record<string, ReadonlySet<string>>> = {
        createManagedStackService: new Set(["repository", "stateRoot"]),
        preflightNative: new Set(["platform"]),
        resolvePortIntents: new Set(["config", "decodedDefaults", "effectiveConfig"]),
        resolveStack: new Set(["cwd", "operation", "stackName", "stateRoot"]),
        resolveStackNames: new Set(["cwd", "stackNames"]),
        runPortableContract: new Set(["runtimes", "scenarioId"]),
        runRepositoryContract: new Set(["adapters", "scenarioId"]),
        startConcurrently: new Set(["contenders", "cwd", "stackName"]),
        startStack: new Set(["auth", "injectCopyFailure", "portIntents", "runtime", "stackId"]),
      };
      const inputMatchesMethod =
        (method === "createManagedStackService" &&
          typeof input.repository === "string" &&
          typeof input.stateRoot === "string") ||
        (method === "preflightNative" && typeof input.platform === "string") ||
        (method === "resolvePortIntents" &&
          (isManagedStackContractRecord(input.config) ||
            isManagedStackContractRecord(input.effectiveConfig))) ||
        (method === "resolveStack" &&
          typeof input.cwd === "string" &&
          typeof input.stackName === "string") ||
        (method === "resolveStackNames" &&
          typeof input.cwd === "string" &&
          Array.isArray(input.stackNames)) ||
        (method === "runPortableContract" &&
          Array.isArray(input.runtimes) &&
          typeof input.scenarioId === "string") ||
        (method === "runRepositoryContract" &&
          Array.isArray(input.adapters) &&
          typeof input.scenarioId === "string") ||
        (method === "startConcurrently" &&
          typeof input.cwd === "string" &&
          typeof input.stackName === "string" &&
          typeof input.contenders === "number") ||
        (method === "startStack" && typeof input.stackId === "string");
      const inputUsesOnlyDeclaredKeys = Object.keys(input).every((key) =>
        allowedInputKeys[method]?.has(key),
      );
      if (!managedMethods.has(method) || !inputMatchesMethod || !inputUsesOnlyDeclaredKeys) {
        errors.push(`${scenario.id}: managed action must use a declared public method`);
      }
    } else if (scenario.when.interface === "stack-api" && scenario.when.method !== "createStack") {
      errors.push(`${scenario.id}: direct stack action must use createStack`);
    }

    if (scenario.when.interface === "cli") {
      const [command, subcommand] = scenario.when.argv;
      const valueFlagsByCommand: Readonly<Record<string, ReadonlySet<string>>> = {
        start: new Set(["--runtime", "--stack"]),
        status: new Set(["--output"]),
        stop: new Set(["--stack", "--stack-id"]),
      };
      const switchFlagsByCommand: Readonly<Record<string, ReadonlySet<string>>> = {
        start: new Set(["--experimental"]),
        status: new Set(["--experimental"]),
        stop: new Set(["--all", "--experimental", "--no-backup"]),
      };
      let validShape = command === "start" || command === "status" || command === "stop";
      if (command === "stack") {
        validShape = subcommand === "prune";
      }
      let index = command === "stack" ? 2 : 1;
      while (validShape && index < scenario.when.argv.length) {
        const argument = scenario.when.argv[index];
        if (argument === undefined) {
          validShape = false;
          break;
        }
        if (command === "stack" && argument === "--experimental") {
          index += 1;
          continue;
        }
        if (command !== undefined && switchFlagsByCommand[command]?.has(argument)) {
          index += 1;
          continue;
        }
        if (command !== undefined && valueFlagsByCommand[command]?.has(argument)) {
          const value = scenario.when.argv[index + 1];
          validShape = value !== undefined;
          if (
            (argument === "--output" && value !== "json") ||
            (argument === "--runtime" && value !== "docker" && value !== "native")
          ) {
            validShape = false;
          }
          index += 2;
          continue;
        }
        validShape = false;
      }
      if (!scenario.when.argv.includes("--experimental") || !validShape) {
        errors.push(`${scenario.id}: CLI action must use a declared experimental command shape`);
      }
    }

    if (scenario.when.interface === "git") {
      const [command, option, branchName] = scenario.when.argv;
      const validShape =
        typeof branchName === "string" &&
        ((command === "switch" && option === "-c") ||
          (command === "branch" && (option === "-D" || option === "-d")));
      if (!validShape) {
        errors.push(`${scenario.id}: Git action must use a declared branch command shape`);
      } else if (
        command === "switch" &&
        scenario.expected.output.human?.summary !== `Switched to a new branch '${branchName}'`
      ) {
        errors.push(`${scenario.id}: Git switch output must match its requested branch`);
      }
    }

    const isStatusOperation =
      (scenario.when.interface === "cli" && scenario.when.argv[0] === "status") ||
      ((scenario.when.interface === "managed-api" || scenario.when.interface === "stack-api") &&
        scenario.when.input.operation === "status");
    if (
      isStatusOperation &&
      scenario.expected.outcome !== "error" &&
      scenario.expected.outcome !== "report"
    ) {
      errors.push(`${scenario.id}: successful status operations must report`);
    }
    if (
      isStatusOperation &&
      (scenario.expected.writes.length > 0 || scenario.expected.runtimeEffects.length > 0)
    ) {
      errors.push(`${scenario.id}: status operations must not mutate state`);
    }

    const { output } = scenario.expected;
    if (output.human === undefined && output.json === undefined && output.api === undefined) {
      errors.push(`${scenario.id}: at least one observable output is required`);
    }

    if (scenario.when.interface === "stack-api" && scenario.when.method === "createStack") {
      const directOptions = scenario.given.filter((fact) => fact.kind === "direct-stack-options");
      const explicitRootKeys = ["cacheRoot", "projectDir", "runtimeRoot", "stackRoot"];
      const directInput = scenario.when.input;
      const hasExplicitRoot = explicitRootKeys.some((key) => typeof directInput[key] === "string");
      const rootMode = hasExplicitRoot ? "explicit" : "omitted";
      const hasTemporaryDetails = scenario.expected.details?.state_root === "temporary";
      const hasTemporaryProjection = output.api?.state_root === "temporary";
      const hasEphemeralWrite = scenario.expected.writes.some(
        (write) => write.target === "ephemeral-state" && write.operation === "create",
      );
      const usesTemporaryState = hasTemporaryDetails && hasTemporaryProjection && hasEphemeralWrite;
      const exposesTemporaryState =
        hasTemporaryDetails || hasTemporaryProjection || hasEphemeralWrite;
      if (
        directOptions.length !== 1 ||
        directOptions[0]?.roots !== rootMode ||
        (rootMode === "omitted" && !usesTemporaryState) ||
        (rootMode === "explicit" && exposesTemporaryState)
      ) {
        errors.push(
          `${scenario.id}: direct stack root inputs must agree with temporary-state behavior`,
        );
      }
    }
    for (const write of scenario.expected.writes) {
      if (write.id.trim().length === 0) {
        errors.push(`${scenario.id}: ${write.target} write requires a target ID`);
      }
    }
    for (const effect of scenario.expected.runtimeEffects) {
      if (effect.stackId.trim().length === 0) {
        errors.push(`${scenario.id}: ${effect.operation} runtime effect requires a stack ID`);
      }
    }

    const cliStackIdIndex =
      scenario.when.interface === "cli" ? scenario.when.argv.indexOf("--stack-id") : -1;
    const explicitActionStackId =
      scenario.when.interface === "cli" && cliStackIdIndex >= 0
        ? scenario.when.argv[cliStackIdIndex + 1]
        : (scenario.when.interface === "managed-api" || scenario.when.interface === "stack-api") &&
            typeof scenario.when.input.stackId === "string"
          ? scenario.when.input.stackId
          : undefined;
    if (explicitActionStackId !== undefined) {
      const expectedStackIds = new Set<string>();
      if (scenario.expected.selection !== undefined) {
        expectedStackIds.add(scenario.expected.selection.stackId);
      }
      for (const write of scenario.expected.writes) {
        if (
          write.target === "managed-state" ||
          write.target === "registry" ||
          write.target === "runtime-state"
        ) {
          expectedStackIds.add(write.id);
        }
      }
      for (const effect of scenario.expected.runtimeEffects) {
        expectedStackIds.add(effect.stackId);
      }
      for (const projectedStackId of [
        output.api?.stackId,
        output.json?.stack_id,
        output.human?.fields.stackId,
      ]) {
        if (typeof projectedStackId === "string") {
          expectedStackIds.add(projectedStackId);
        }
      }
      for (const expectedStackId of expectedStackIds) {
        if (expectedStackId !== explicitActionStackId) {
          errors.push(
            `${scenario.id}: explicit action target ${explicitActionStackId} disagrees with expected stack ${expectedStackId}`,
          );
        }
      }
    }

    const cliStackNameIndex =
      scenario.when.interface === "cli" ? scenario.when.argv.indexOf("--stack") : -1;
    const explicitActionStackName =
      scenario.when.interface === "cli" && cliStackNameIndex >= 0
        ? scenario.when.argv[cliStackNameIndex + 1]
        : (scenario.when.interface === "managed-api" || scenario.when.interface === "stack-api") &&
            typeof scenario.when.input.stackName === "string"
          ? scenario.when.input.stackName
          : undefined;
    if (
      explicitActionStackName !== undefined &&
      scenario.expected.selection !== undefined &&
      explicitActionStackName !== scenario.expected.selection.stackName
    ) {
      errors.push(
        `${scenario.id}: explicit stack name ${explicitActionStackName} disagrees with selected stack ${scenario.expected.selection.stackName}`,
      );
    }

    const cliRuntimeIndex =
      scenario.when.interface === "cli" ? scenario.when.argv.indexOf("--runtime") : -1;
    const explicitRuntime =
      scenario.when.interface === "cli" && cliRuntimeIndex >= 0
        ? scenario.when.argv[cliRuntimeIndex + 1]
        : scenario.when.interface === "managed-api" &&
            typeof scenario.when.input.runtime === "string"
          ? scenario.when.input.runtime
          : undefined;
    if (explicitRuntime !== undefined) {
      const actionRequestSource = scenario.when.interface === "cli" ? "cli" : "managed-api";
      const runtimeRequest = scenario.given.find(
        (fact) =>
          fact.kind === "runtime-request" &&
          fact.runtime === explicitRuntime &&
          (explicitRuntime === "auto" || fact.source === actionRequestSource),
      );
      if (runtimeRequest?.kind !== "runtime-request") {
        errors.push(
          `${scenario.id}: explicit runtime ${explicitRuntime} must match its ${actionRequestSource} request fact`,
        );
      }
      if (explicitRuntime !== "auto") {
        for (const projectedRuntime of [
          scenario.expected.details?.resolved_runtime,
          output.api?.runtime,
          output.json?.runtime,
          output.human?.fields.runtime,
        ]) {
          if (projectedRuntime !== undefined && projectedRuntime !== explicitRuntime) {
            errors.push(
              `${scenario.id}: resolved runtime must match explicit request ${explicitRuntime}`,
            );
          }
        }
        if (isManagedStartAction(scenario.when) && scenario.expected.outcome !== "error") {
          const availability = scenario.given.find(
            (fact) => fact.kind === "runtime-availability" && fact.runtime === explicitRuntime,
          );
          if (availability?.kind !== "runtime-availability" || availability.available !== true) {
            errors.push(
              `${scenario.id}: successful explicit runtime requires matching availability`,
            );
          }
        }
      }
    }

    const runtimeRequests = scenario.given.filter((fact) => fact.kind === "runtime-request");
    const effectiveRuntimeRequest =
      runtimeRequests.find((fact) => fact.source === "cli" || fact.source === "managed-api") ??
      runtimeRequests.find((fact) => fact.source === "config") ??
      runtimeRequests.find((fact) => fact.source === "default");
    if (
      isManagedStartAction(scenario.when) &&
      effectiveRuntimeRequest?.kind === "runtime-request" &&
      effectiveRuntimeRequest.runtime === "auto"
    ) {
      const persistedRuntime = scenario.given.find((fact) => fact.kind === "persisted-runtime");
      const dockerAvailability = scenario.given.find(
        (fact) => fact.kind === "runtime-availability" && fact.runtime === "docker",
      );
      const nativeAvailability = scenario.given.find(
        (fact) => fact.kind === "runtime-availability" && fact.runtime === "native",
      );
      const nativeQualification = scenario.given.find(
        (fact) => fact.kind === "native-qualification",
      );
      const nativeQualified =
        nativeQualification?.kind === "native-qualification" &&
        nativeQualification.failedServices.length === 0 &&
        nativeQualification.qualifiedServices.length === nativeServices.length;
      const persistedAvailability =
        persistedRuntime?.kind === "persisted-runtime"
          ? scenario.given.find(
              (fact) =>
                fact.kind === "runtime-availability" && fact.runtime === persistedRuntime.runtime,
            )
          : undefined;
      const resolvedRuntime =
        persistedRuntime?.kind === "persisted-runtime" &&
        persistedAvailability?.kind === "runtime-availability" &&
        !persistedAvailability.available
          ? undefined
          : persistedRuntime?.kind === "persisted-runtime"
            ? persistedRuntime.runtime
            : dockerAvailability?.kind === "runtime-availability" && dockerAvailability.available
              ? "docker"
              : nativeAvailability?.kind === "runtime-availability" &&
                  nativeAvailability.available &&
                  nativeQualified
                ? "native"
                : undefined;
      if (
        persistedRuntime?.kind === "persisted-runtime" &&
        persistedAvailability?.kind === "runtime-availability" &&
        !persistedAvailability.available
      ) {
        if (
          scenario.expected.outcome !== "error" ||
          scenario.expected.error?.code !== "persisted_runtime_unavailable" ||
          output.json?.runtime !== persistedRuntime.runtime ||
          scenario.expected.runtimeEffects.some((effect) => effect.operation === "start")
        ) {
          errors.push(`${scenario.id}: unavailable persisted runtime must fail without switching`);
        }
      } else if (resolvedRuntime === undefined) {
        if (
          scenario.expected.outcome !== "error" ||
          scenario.expected.error?.code !== "no_runtime_available" ||
          scenario.expected.runtimeEffects.some((effect) => effect.operation === "start")
        ) {
          errors.push(`${scenario.id}: automatic runtime must fail when no runtime is usable`);
        }
      } else {
        const projectedRuntimes = [
          scenario.expected.details?.resolved_runtime,
          output.api?.runtime,
          output.json?.runtime,
          output.human?.fields.runtime,
        ].filter((runtime) => runtime !== undefined);
        if (
          scenario.expected.outcome === "error" ||
          projectedRuntimes.length === 0 ||
          projectedRuntimes.some((runtime) => runtime !== resolvedRuntime)
        ) {
          errors.push(
            `${scenario.id}: automatic runtime must resolve from persisted state or declared availability`,
          );
        }
      }
    }

    if (scenario.when.interface === "managed-api" && typeof scenario.when.input.auth === "string") {
      const authReference = scenario.when.input.auth;
      const configuredCredentials = scenario.given.find(
        (fact) => fact.kind === "credential-state" && fact.source === "configured",
      );
      if (
        configuredCredentials?.kind !== "credential-state" ||
        configuredCredentials.valuesId !== authReference ||
        scenario.expected.details?.credential_values_id !== authReference ||
        scenario.expected.details.global_credentials_reference !== authReference ||
        output.api?.credentialsValuesId !== authReference
      ) {
        errors.push(
          `${scenario.id}: configured credential input ${authReference} must match persisted references`,
        );
      }
    }

    if (scenario.when.interface === "managed-api" && scenario.when.method === "resolveStack") {
      const stateRoot = scenario.when.input.stateRoot;
      const isolatedOptions = scenario.given.find(
        (fact) => fact.kind === "managed-api-options" && fact.stateRoot === "isolated",
      );
      if (isolatedOptions?.kind === "managed-api-options") {
        if (
          typeof stateRoot !== "string" ||
          isolatedOptions.stateRootPath !== stateRoot ||
          scenario.expected.details?.state_root !== stateRoot ||
          scenario.expected.details.default_system_state_mutated !== false
        ) {
          errors.push(
            `${scenario.id}: isolated state root input must match its options and observed boundary`,
          );
        }
      }
    }

    if (
      scenario.when.interface === "managed-api" &&
      scenario.when.method === "createManagedStackService"
    ) {
      const repositoryId = scenario.when.input.repository;
      const stateRootPath = scenario.when.input.stateRoot;
      const injectedOptions = scenario.given.find(
        (fact) => fact.kind === "managed-api-options" && fact.repository === "injected",
      );
      if (
        typeof repositoryId !== "string" ||
        typeof stateRootPath !== "string" ||
        injectedOptions?.kind !== "managed-api-options" ||
        injectedOptions.repositoryId !== repositoryId ||
        injectedOptions.stateRoot !== "isolated" ||
        injectedOptions.stateRootPath !== stateRootPath ||
        !scenario.expected.writes.some(
          (write) =>
            write.target === "ephemeral-state" &&
            write.operation === "create" &&
            write.id === repositoryId,
        ) ||
        output.api?.repository !== repositoryId
      ) {
        errors.push(
          `${scenario.id}: injected repository and state root must match the observed managed service`,
        );
      }
    }

    if (scenario.when.interface === "managed-api" && scenario.when.method === "resolveStackNames") {
      const requestedNames = scenario.when.input.stackNames;
      const declaredNames = scenario.given.find((fact) => fact.kind === "stack-names");
      const detailKeys = Object.keys(scenario.expected.details ?? {});
      const apiKeys = Object.keys(output.api ?? {});
      if (
        !Array.isArray(requestedNames) ||
        !requestedNames.every((name) => typeof name === "string") ||
        declaredNames?.kind !== "stack-names" ||
        !managedStackContractStringSetEquals(requestedNames, declaredNames.names) ||
        !managedStackContractStringSetEquals(requestedNames, detailKeys) ||
        !managedStackContractStringSetEquals(requestedNames, apiKeys)
      ) {
        errors.push(
          `${scenario.id}: requested stack names must match their fact and projected results`,
        );
      }
    }

    if (
      scenario.when.interface === "managed-api" &&
      scenario.when.method === "resolvePortIntents"
    ) {
      const configFacts = scenario.given.filter((fact) => fact.kind === "config-port");
      const projectedKeys = Object.keys(output.api ?? {});
      if (
        !managedStackContractStringSetEquals(
          configFacts.map(({ key }) => key),
          projectedKeys,
        )
      ) {
        errors.push(`${scenario.id}: resolved port keys must match their config facts`);
      }
      if (isManagedStackContractRecord(scenario.when.input.config)) {
        const decodedDefaults = scenario.when.input.decodedDefaults;
        if (
          !isManagedStackContractRecord(decodedDefaults) ||
          !managedStackContractStringSetEquals(
            configFacts.map(({ key }) => key),
            Object.keys(decodedDefaults),
          )
        ) {
          errors.push(`${scenario.id}: decoded default keys must cover resolved port facts`);
        }
      }
      for (const fact of configFacts) {
        const projection = output.api?.[fact.key];
        const effectiveConfig = isManagedStackContractRecord(scenario.when.input.effectiveConfig)
          ? scenario.when.input.effectiveConfig
          : undefined;
        const localConfig = isManagedStackContractRecord(scenario.when.input.config)
          ? scenario.when.input.config
          : undefined;
        const actionValue = effectiveConfig?.[fact.key] ?? localConfig?.[fact.key];
        if (
          !isManagedStackContractRecord(projection) ||
          projection.intent !== fact.intent ||
          projection.source !== fact.source ||
          (fact.intent === "exact" &&
            (actionValue !== fact.value || projection.port !== fact.value)) ||
          (fact.intent === "automatic" && localConfig?.[fact.key] !== undefined)
        ) {
          errors.push(`${scenario.id}: resolved port ${fact.key} must match its input and fact`);
        }
      }
    }

    if (
      scenario.when.interface === "cli" &&
      (scenario.when.argv[0] === "start" ||
        scenario.when.argv[0] === "status" ||
        scenario.when.argv[0] === "stop") &&
      !scenario.when.argv.includes("--stack-id") &&
      typeof output.json?.stack_id === "string" &&
      scenario.expected.selection === undefined
    ) {
      errors.push(`${scenario.id}: contextual CLI stack result requires a selected target`);
    }

    if (
      scenario.when.interface === "managed-api" &&
      scenario.when.method === "runPortableContract"
    ) {
      const referencedId = scenario.when.input.scenarioId;
      const referencedScenario =
        typeof referencedId === "string" ? fixturesById.get(referencedId) : undefined;
      if (referencedScenario === undefined) {
        errors.push(`${scenario.id}: portable contract must reference a declared scenario`);
      } else {
        const runtimes = scenario.when.input.runtimes;
        if (
          !Array.isArray(runtimes) ||
          runtimes.length === 0 ||
          !runtimes.every((runtime) => typeof runtime === "string" && runtime.length > 0)
        ) {
          errors.push(`${scenario.id}: portable contract must declare its runtimes`);
        } else {
          if (new Set(runtimes).size !== runtimes.length) {
            errors.push(`${scenario.id}: portable contract runtimes must be unique`);
          }
          const runtimeFacts = scenario.given.flatMap((fact) =>
            fact.kind === "managed-api-options" ? [fact.runtime] : [],
          );
          const declaredRuntimeSet = new Set(runtimes);
          const runtimeFactSet = new Set(runtimeFacts);
          if (
            declaredRuntimeSet.size !== runtimeFactSet.size ||
            [...declaredRuntimeSet].some((runtime) => !runtimeFactSet.has(runtime))
          ) {
            errors.push(`${scenario.id}: portable runtimes must match declared runtime facts`);
          }
          const runtimeOptions = scenario.given.filter(
            (fact) => fact.kind === "managed-api-options",
          );
          const firstRuntimeOptions = runtimeOptions[0];
          if (
            firstRuntimeOptions === undefined ||
            runtimeOptions.length !== runtimes.length ||
            runtimes.some(
              (runtime) =>
                runtimeOptions.filter((options) => options.runtime === runtime).length !== 1,
            ) ||
            runtimeOptions.some(
              (options) =>
                options.repository !== firstRuntimeOptions.repository ||
                options.repositoryId !== firstRuntimeOptions.repositoryId ||
                options.stateRoot !== firstRuntimeOptions.stateRoot ||
                options.stateRootPath !== firstRuntimeOptions.stateRootPath,
            )
          ) {
            errors.push(
              `${scenario.id}: portable comparison must hold repository and state root constant`,
            );
          }

          let firstRuntimeResult: Readonly<Record<string, ManagedStackContractJson>> | undefined;
          let runtimeResultsEqual = true;
          for (const runtime of runtimes) {
            const runtimeResult = output.api?.[runtime];
            if (
              !isManagedStackContractRecord(runtimeResult) ||
              runtimeResult.outcome !== referencedScenario.expected.outcome
            ) {
              runtimeResultsEqual = false;
              errors.push(
                `${scenario.id}: portable ${runtime} outcome must match ${referencedScenario.id}`,
              );
              continue;
            }
            if (
              referencedScenario.expected.selection !== undefined &&
              runtimeResult.stackId !== referencedScenario.expected.selection.stackId
            ) {
              errors.push(
                `${scenario.id}: portable ${runtime} stackId must match ${referencedScenario.id}`,
              );
            }
            if (firstRuntimeResult === undefined) {
              firstRuntimeResult = runtimeResult;
            } else if (!managedStackContractJsonEquals(firstRuntimeResult, runtimeResult)) {
              runtimeResultsEqual = false;
              errors.push(`${scenario.id}: portable runtime decisions must be identical`);
            }
          }
          if (
            scenario.expected.details?.results_equal !== runtimeResultsEqual ||
            output.api?.equal !== runtimeResultsEqual
          ) {
            errors.push(`${scenario.id}: portable equality flags must match compared results`);
          }
        }
      }
    }

    if (
      scenario.when.interface === "managed-api" &&
      scenario.when.method === "runRepositoryContract"
    ) {
      const referencedId = scenario.when.input.scenarioId;
      const referencedScenario =
        typeof referencedId === "string" ? fixturesById.get(referencedId) : undefined;
      if (referencedScenario === undefined) {
        errors.push(`${scenario.id}: repository contract must reference a declared scenario`);
      } else {
        const adapters = scenario.when.input.adapters;
        if (
          !Array.isArray(adapters) ||
          adapters.length === 0 ||
          !adapters.every((adapter) => typeof adapter === "string" && adapter.length > 0)
        ) {
          errors.push(`${scenario.id}: repository contract must declare its adapters`);
        } else {
          if (new Set(adapters).size !== adapters.length) {
            errors.push(`${scenario.id}: repository contract adapters must be unique`);
          }
          const repositoryFacts = scenario.given.flatMap((fact) =>
            fact.kind === "managed-api-options" ? [fact.repository] : [],
          );
          const declaredRepositorySet = new Set(adapters);
          const repositoryFactSet = new Set(repositoryFacts);
          if (
            declaredRepositorySet.size !== repositoryFactSet.size ||
            [...declaredRepositorySet].some((adapter) => !repositoryFactSet.has(adapter))
          ) {
            errors.push(`${scenario.id}: repository adapters must match declared repository facts`);
          }
          const repositoryOptions = scenario.given.filter(
            (fact) => fact.kind === "managed-api-options",
          );
          const firstRepositoryOptions = repositoryOptions[0];
          if (
            firstRepositoryOptions === undefined ||
            repositoryOptions.length !== adapters.length ||
            adapters.some(
              (adapter) =>
                repositoryOptions.filter((options) => options.repository === adapter).length !== 1,
            ) ||
            repositoryOptions.some(
              (options) =>
                options.runtime !== firstRepositoryOptions.runtime ||
                options.stateRoot !== firstRepositoryOptions.stateRoot ||
                options.stateRootPath !== firstRepositoryOptions.stateRootPath,
            )
          ) {
            errors.push(
              `${scenario.id}: repository comparison must hold runtime and state root constant`,
            );
          }

          let firstAdapterResult: Readonly<Record<string, ManagedStackContractJson>> | undefined;
          let adapterResultsEqual = true;
          for (const adapter of adapters) {
            const adapterResult = output.api?.[adapter];
            if (
              !isManagedStackContractRecord(adapterResult) ||
              adapterResult.outcome !== referencedScenario.expected.outcome
            ) {
              adapterResultsEqual = false;
              errors.push(
                `${scenario.id}: repository ${adapter} outcome must match ${referencedScenario.id}`,
              );
              continue;
            }
            if (
              referencedScenario.expected.selection !== undefined &&
              adapterResult.stackId !== referencedScenario.expected.selection.stackId
            ) {
              errors.push(
                `${scenario.id}: repository ${adapter} stackId must match ${referencedScenario.id}`,
              );
            }
            if (firstAdapterResult === undefined) {
              firstAdapterResult = adapterResult;
            } else if (!managedStackContractJsonEquals(firstAdapterResult, adapterResult)) {
              adapterResultsEqual = false;
              errors.push(`${scenario.id}: repository adapter decisions must be identical`);
            }
          }
          if (
            scenario.expected.details?.decisions_equal !== adapterResultsEqual ||
            output.api?.equal !== adapterResultsEqual
          ) {
            errors.push(`${scenario.id}: repository equality flags must match compared decisions`);
          }
        }
      }
    }

    if (scenario.expected.outcome === "error") {
      if (scenario.expected.error === undefined) {
        errors.push(`${scenario.id}: error outcome requires structured error metadata`);
      } else if (scenario.expected.error.recovery.length === 0) {
        errors.push(`${scenario.id}: error outcome requires recovery guidance`);
      }
    } else if (scenario.expected.error !== undefined) {
      errors.push(`${scenario.id}: non-error outcome cannot include error metadata`);
    }

    if (scenario.expected.warning !== undefined) {
      if (scenario.expected.outcome === "error") {
        errors.push(`${scenario.id}: error outcome cannot also include warning metadata`);
      }
      if (scenario.expected.warning.recovery.length === 0) {
        errors.push(`${scenario.id}: warning metadata requires recovery guidance`);
      }
    }

    const declaredIds = new Set<string>();
    const projectIds = new Set<string>();
    const checkoutIds = new Set<string>();
    const contextIds = new Set<string>();
    const existingCheckoutIdentityIds = new Set<string>();
    for (const fact of scenario.given) {
      switch (fact.kind) {
        case "branch":
          declaredIds.add(fact.contextId);
          contextIds.add(fact.contextId);
          break;
        case "checkout":
          declaredIds.add(fact.projectId);
          declaredIds.add(fact.checkoutId);
          projectIds.add(fact.projectId);
          checkoutIds.add(fact.checkoutId);
          existingCheckoutIdentityIds.add(fact.projectId);
          existingCheckoutIdentityIds.add(fact.checkoutId);
          break;
        case "credential-state":
          declaredIds.add(fact.valuesId);
          if (fact.previousValuesId !== undefined) {
            declaredIds.add(fact.previousValuesId);
          }
          break;
        case "identity-claim":
          if (fact.status !== "absent") {
            declaredIds.add(fact.id);
          }
          switch (fact.scope) {
            case "checkout":
              checkoutIds.add(fact.id);
              break;
            case "context":
              contextIds.add(fact.id);
              break;
            case "project":
              projectIds.add(fact.id);
              break;
          }
          break;
        case "identity-marker":
          declaredIds.add(fact.markerId);
          declaredIds.add(fact.projectId);
          declaredIds.add(fact.checkoutId);
          declaredIds.add(fact.contextId);
          projectIds.add(fact.projectId);
          checkoutIds.add(fact.checkoutId);
          contextIds.add(fact.contextId);
          existingCheckoutIdentityIds.add(fact.projectId);
          existingCheckoutIdentityIds.add(fact.checkoutId);
          break;
        case "managed-record":
        case "managed-target":
        case "persisted-runtime":
          declaredIds.add(fact.stackId);
          break;
        case "operation-result":
          declaredIds.add(fact.stackId);
          break;
        case "occupied-port":
          if (fact.ownerId !== undefined) {
            declaredIds.add(fact.ownerId);
          }
          break;
        case "port-assignment":
          declaredIds.add(fact.stackId);
          break;
        case "stack":
          declaredIds.add(fact.contextId);
          declaredIds.add(fact.stackId);
          contextIds.add(fact.contextId);
          break;
        default:
          break;
      }
    }

    const actionCwd =
      scenario.when.interface === "cli" || scenario.when.interface === "git"
        ? scenario.when.cwd
        : typeof scenario.when.input.cwd === "string"
          ? scenario.when.input.cwd
          : undefined;
    if (
      scenario.when.interface === "managed-api" &&
      scenario.when.input.cwd !== undefined &&
      (actionCwd === undefined ||
        !scenario.given.some(
          (fact) =>
            (fact.kind === "checkout" && fact.path === actionCwd) ||
            (fact.kind === "workspace" &&
              (fact.path === actionCwd || fact.canonicalPath === actionCwd)) ||
            (fact.kind === "git-state" && fact.workspacePath === actionCwd),
        ))
    ) {
      errors.push(`${scenario.id}: managed action cwd must match a declared workspace`);
    }
    if (scenario.when.interface === "cli") {
      const declaredActionPaths = scenario.given.flatMap((fact) => {
        if (fact.kind === "checkout" || fact.kind === "git-state") {
          return [fact.kind === "checkout" ? fact.path : fact.workspacePath];
        }
        if (fact.kind === "workspace") {
          return fact.canonicalPath === undefined ? [fact.path] : [fact.path, fact.canonicalPath];
        }
        return [];
      });
      if (declaredActionPaths.length > 0 && !declaredActionPaths.includes(scenario.when.cwd)) {
        errors.push(`${scenario.id}: CLI action cwd must match a declared workspace`);
      }
    }
    if (
      scenario.when.interface === "managed-api" &&
      scenario.when.method === "resolveStack" &&
      scenario.when.input.operation !== undefined &&
      scenario.when.input.operation !== "start" &&
      scenario.when.input.operation !== "status"
    ) {
      errors.push(`${scenario.id}: resolveStack operation must be start or status`);
    }
    const actionGitState = scenario.given.find(
      (fact) => fact.kind === "git-state" && fact.workspacePath === actionCwd,
    );
    const checkedOutBranch = scenario.given.find(
      (fact) => fact.kind === "branch" && fact.checkedOut,
    );
    if (
      scenario.when.interface === "git" &&
      scenario.when.argv[0] === "branch" &&
      (scenario.when.argv[1] === "-D" || scenario.when.argv[1] === "-d")
    ) {
      if (
        scenario.expected.details?.stack_orphaned !== true ||
        scenario.expected.details.stack_data_preserved !== true
      ) {
        errors.push(`${scenario.id}: branch deletion must preserve and orphan managed stack data`);
      }
      const deletedBranchName = scenario.when.argv[2];
      const deletedBranch = scenario.given.find(
        (fact) => fact.kind === "branch" && fact.name === deletedBranchName,
      );
      const affectedStack =
        deletedBranch?.kind === "branch"
          ? scenario.given.find(
              (fact) => fact.kind === "stack" && fact.contextId === deletedBranch.contextId,
            )
          : undefined;
      if (
        deletedBranchName === undefined ||
        deletedBranch?.kind !== "branch" ||
        affectedStack?.kind !== "stack"
      ) {
        errors.push(
          `${scenario.id}: branch deletion must bind its branch to an affected managed stack`,
        );
      } else {
        if (deletedBranch.checkedOut) {
          errors.push(`${scenario.id}: deleted branch ${deletedBranchName} cannot be checked out`);
        }
        if (scenario.expected.details?.orphaned_stack_id !== affectedStack.stackId) {
          errors.push(
            `${scenario.id}: orphaned stack must be ${affectedStack.stackId} for branch ${deletedBranchName}`,
          );
        }
      }
      if (
        actionCwd === undefined ||
        !scenario.given.some((fact) => fact.kind === "checkout" && fact.path === actionCwd) ||
        !scenario.given.some(
          (fact) => fact.kind === "git-state" && fact.workspacePath === actionCwd,
        )
      ) {
        errors.push(`${scenario.id}: branch deletion must declare checkout Git state`);
      }
    }
    if (
      actionCwd !== undefined &&
      scenario.given.some(
        (fact) =>
          fact.kind === "workspace" &&
          fact.path === actionCwd &&
          (fact.mode === "bare-worktree" || fact.mode === "linked-worktree"),
      ) &&
      !scenario.given.some((fact) => fact.kind === "git-state" && fact.workspacePath === actionCwd)
    ) {
      errors.push(`${scenario.id}: resolving worktree ${actionCwd} requires its Git state`);
    }

    const detachedGitState = scenario.given.find(
      (fact) =>
        fact.kind === "git-state" && fact.workspacePath === actionCwd && fact.head === "detached",
    );
    if (
      detachedGitState?.kind === "git-state" &&
      scenario.expected.outcome === "reuse" &&
      !scenario.given.some(
        (fact) =>
          fact.kind === "identity-transition" &&
          fact.operation === "detached-commit" &&
          fact.to === detachedGitState.commit,
      )
    ) {
      errors.push(`${scenario.id}: detached reuse must declare the commit transition`);
    }

    if (scenario.expected.error?.code === "duplicate_checkout_claim") {
      const copiedWorkspace = scenario.given.find(
        (fact) => fact.kind === "workspace" && fact.path === actionCwd,
      );
      const duplicateClaim = scenario.given.find(
        (fact) => fact.kind === "identity-claim" && fact.scope === "checkout",
      );
      const copyTransition = scenario.given.find(
        (fact) => fact.kind === "identity-transition" && fact.operation === "checkout-copy",
      );
      const projectedPaths = output.json?.paths;
      if (
        copiedWorkspace?.kind !== "workspace" ||
        copiedWorkspace.copiedFrom === undefined ||
        duplicateClaim?.kind !== "identity-claim" ||
        duplicateClaim.status !== "duplicate" ||
        duplicateClaim.path !== copiedWorkspace.copiedFrom ||
        copyTransition?.kind !== "identity-transition" ||
        copyTransition.from !== copiedWorkspace.copiedFrom ||
        copyTransition.to !== copiedWorkspace.path ||
        output.json?.checkout_id !== duplicateClaim.id ||
        !Array.isArray(projectedPaths) ||
        projectedPaths.length !== 2 ||
        !projectedPaths.includes(copiedWorkspace.path) ||
        !projectedPaths.includes(copiedWorkspace.copiedFrom)
      ) {
        errors.push(
          `${scenario.id}: duplicate checkout error must bind both conflicting live paths`,
        );
      }
    }

    if (scenario.expected.error?.code === "checkout_path_inaccessible") {
      const movedWorkspace = scenario.given.find(
        (fact) => fact.kind === "workspace" && fact.path === actionCwd,
      );
      const ambiguousClaim = scenario.given.find(
        (fact) => fact.kind === "identity-claim" && fact.scope === "checkout",
      );
      if (
        movedWorkspace?.kind !== "workspace" ||
        movedWorkspace.previousPathAccess !== "inaccessible" ||
        movedWorkspace.previousPath === undefined ||
        ambiguousClaim?.kind !== "identity-claim" ||
        ambiguousClaim.status !== "ambiguous" ||
        ambiguousClaim.path !== movedWorkspace.previousPath ||
        output.human?.fields.previousPath !== movedWorkspace.previousPath ||
        output.human?.fields.currentPath !== movedWorkspace.path ||
        output.json?.checkout_id !== ambiguousClaim.id
      ) {
        errors.push(
          `${scenario.id}: inaccessible checkout error must bind path access and ambiguous claim`,
        );
      }
    }

    if (output.api?.rebound === true) {
      const movedWorkspace = scenario.given.find(
        (fact) => fact.kind === "workspace" && fact.path === actionCwd,
      );
      const exactClaim = scenario.given.find(
        (fact) => fact.kind === "identity-claim" && fact.scope === "checkout",
      );
      if (
        movedWorkspace?.kind !== "workspace" ||
        movedWorkspace.previousPathAccess !== "missing" ||
        movedWorkspace.previousPath === undefined ||
        exactClaim?.kind !== "identity-claim" ||
        exactClaim.status !== "exact" ||
        exactClaim.path !== movedWorkspace.previousPath ||
        output.api?.checkoutId !== exactClaim.id
      ) {
        errors.push(`${scenario.id}: automatic checkout rebind requires a missing previous path`);
      }
    }

    for (const fact of scenario.given) {
      if (fact.kind !== "native-qualification") {
        continue;
      }

      if (
        !managedNativeServiceMatrix.targetPlatforms.includes(fact.platform) &&
        !managedNativeServiceMatrix.unsupportedPlatforms.includes(fact.platform)
      ) {
        errors.push(`${scenario.id}: native qualification uses unknown platform ${fact.platform}`);
      }
      if (
        scenario.when.interface === "managed-api" &&
        scenario.when.method === "preflightNative" &&
        (typeof scenario.when.input.platform !== "string" ||
          scenario.when.input.platform !== fact.platform ||
          scenario.expected.output.api?.platform !== fact.platform)
      ) {
        errors.push(
          `${scenario.id}: native qualification platform must match the preflight action`,
        );
      }

      const qualified = new Set<ServiceName>();
      const failed = new Set<ServiceName>();
      for (const service of fact.qualifiedServices) {
        if (!nativeServiceSet.has(service)) {
          errors.push(`${scenario.id}: native qualification contains unknown service ${service}`);
        }
        if (qualified.has(service)) {
          errors.push(`${scenario.id}: native qualification duplicates service ${service}`);
        }
        qualified.add(service);
      }
      for (const service of fact.failedServices) {
        if (!nativeServiceSet.has(service)) {
          errors.push(`${scenario.id}: native qualification contains unknown service ${service}`);
        }
        if (failed.has(service)) {
          errors.push(`${scenario.id}: native qualification duplicates service ${service}`);
        }
        if (qualified.has(service)) {
          errors.push(`${scenario.id}: native qualification places ${service} in both partitions`);
        }
        failed.add(service);
      }
      for (const service of nativeServices) {
        if (!qualified.has(service) && !failed.has(service)) {
          errors.push(`${scenario.id}: native qualification omits service ${service}`);
        }
      }
      if (scenario.when.interface === "managed-api" && scenario.when.method === "preflightNative") {
        const platformQualified = failed.size === 0 && qualified.size === nativeServices.length;
        if (
          scenario.expected.outcome !== (platformQualified ? "report" : "error") ||
          scenario.expected.details?.qualified !== platformQualified ||
          scenario.expected.details.qualified_service_count !== qualified.size ||
          scenario.expected.details.failed_service_count !== failed.size ||
          scenario.expected.output.api?.qualified !== platformQualified
        ) {
          errors.push(
            `${scenario.id}: native preflight decision must match its qualification partitions`,
          );
        }
        const projectedServices = scenario.expected.output.api?.services;
        if (
          platformQualified &&
          (!Array.isArray(projectedServices) ||
            !managedStackContractJsonEquals(projectedServices, fact.qualifiedServices))
        ) {
          errors.push(`${scenario.id}: native preflight services must match qualified services`);
        }
        const projectedFailures = scenario.expected.output.api?.failedServices;
        if (
          !platformQualified &&
          (!Array.isArray(projectedFailures) ||
            !managedStackContractJsonEquals(projectedFailures, fact.failedServices))
        ) {
          errors.push(`${scenario.id}: native preflight failures must match failed services`);
        }
      }
    }

    if (scenario.expected.error?.code === "native_platform_unsupported") {
      const qualification = scenario.given.find((fact) => fact.kind === "native-qualification");
      const projectedPlatforms = output.json?.supported_platforms;
      if (
        qualification?.kind !== "native-qualification" ||
        !managedNativeServiceMatrix.unsupportedPlatforms.includes(qualification.platform) ||
        output.json?.platform !== qualification.platform ||
        !Array.isArray(projectedPlatforms) ||
        projectedPlatforms.length !== managedNativeServiceMatrix.targetPlatforms.length ||
        !managedNativeServiceMatrix.targetPlatforms.every((platform) =>
          projectedPlatforms.includes(platform),
        ) ||
        explicitRuntime !== "native"
      ) {
        errors.push(`${scenario.id}: unsupported native error must bind an unsupported platform`);
      }
    }

    const writesIdentityMarker = scenario.expected.writes.some(
      (write) => write.target === "identity-marker",
    );
    if (writesIdentityMarker) {
      if (
        scenario.given.some(
          (fact) => fact.kind === "git-state" && fact.trackedIdentityMarker === true,
        )
      ) {
        errors.push(`${scenario.id}: a tracked identity marker must remain untouched`);
      } else if (
        scenario.given.some((fact) => fact.kind === "workspace" && fact.mode !== "ordinary-folder")
      ) {
        errors.push(`${scenario.id}: Git workspace identity must use Git-local metadata`);
      }
    }

    if (scenario.expected.outcome !== "create") {
      for (const effect of scenario.expected.runtimeEffects) {
        if (effect.operation !== "start") {
          continue;
        }
        const explicitlyStopped = scenario.given.some(
          (fact) =>
            fact.kind === "stack" &&
            fact.stackId === effect.stackId &&
            fact.lifecycle === "stopped",
        );
        if (!explicitlyStopped) {
          errors.push(
            `${scenario.id}: starting existing stack ${effect.stackId} requires an explicit stopped lifecycle`,
          );
        }
      }
    }

    for (const target of scenario.given) {
      if (
        target.kind === "managed-target" &&
        !target.exists &&
        scenario.given.some((fact) => fact.kind === "stack" && fact.stackId === target.stackId)
      ) {
        errors.push(
          `${scenario.id}: absent managed target ${target.stackId} contradicts an existing stack`,
        );
      }
    }

    const createdStackIds = scenario.expected.writes.flatMap((write) =>
      write.target === "managed-state" && write.operation === "create" ? [write.id] : [],
    );
    for (const stackId of createdStackIds) {
      if (
        !scenario.given.some(
          (fact) => fact.kind === "managed-target" && fact.stackId === stackId && !fact.exists,
        )
      ) {
        errors.push(`${scenario.id}: managed creation must declare absent target ${stackId}`);
      }
    }
    if (
      isManagedStartAction(scenario.when) &&
      scenario.expected.outcome === "create" &&
      createdStackIds.length > 0
    ) {
      const legacyState = scenario.given.find((fact) => fact.kind === "legacy-state");
      const legacyAllowsFreshCreation =
        legacyState?.kind === "legacy-state" &&
        ((legacyState.lifecycle === "absent" &&
          legacyState.database === "absent" &&
          legacyState.storage === "absent" &&
          legacyState.credentials === "absent") ||
          (legacyState.lifecycle === "stopped" &&
            (legacyState.database === "incompatible" ||
              legacyState.storage === "incompatible" ||
              legacyState.credentials === "incompatible")));
      if (!legacyAllowsFreshCreation) {
        errors.push(
          `${scenario.id}: managed creation must declare legacy state absent or incompatible`,
        );
      }
    }

    const copiedStackIds = new Set(
      scenario.expected.writes.flatMap((write) =>
        write.target === "managed-state" && write.operation === "copy" ? [write.id] : [],
      ),
    );
    for (const effect of scenario.expected.runtimeEffects) {
      if (effect.operation === "copy") {
        copiedStackIds.add(effect.stackId);
      }
    }
    if (copiedStackIds.size > 0) {
      const legacyState = scenario.given.find((fact) => fact.kind === "legacy-state");
      const legacyIsCopyable =
        legacyState?.kind === "legacy-state" &&
        legacyState.lifecycle === "stopped" &&
        legacyState.database === "compatible" &&
        legacyState.storage === "compatible" &&
        legacyState.credentials === "compatible";
      for (const stackId of copiedStackIds) {
        if (
          !scenario.given.some(
            (fact) => fact.kind === "managed-target" && fact.stackId === stackId && !fact.exists,
          ) ||
          !legacyIsCopyable
        ) {
          errors.push(
            `${scenario.id}: bootstrap copy requires absent target ${stackId} and compatible stopped legacy state`,
          );
        }
      }
    }

    for (const effect of scenario.expected.runtimeEffects) {
      if (effect.operation !== "start") {
        continue;
      }
      const createsTarget = scenario.expected.writes.some(
        (write) =>
          write.target === "managed-state" &&
          (write.operation === "create" || write.operation === "copy") &&
          write.id === effect.stackId,
      );
      const targetExists = scenario.given.some(
        (fact) =>
          (fact.kind === "managed-target" && fact.stackId === effect.stackId && fact.exists) ||
          (fact.kind === "stack" && fact.stackId === effect.stackId),
      );
      if (!createsTarget && !targetExists) {
        errors.push(
          `${scenario.id}: starting existing stack ${effect.stackId} requires an existing managed target`,
        );
      }
    }

    if (scenario.expected.error?.code === "persisted_runtime_unavailable") {
      for (const fact of scenario.given) {
        if (fact.kind !== "persisted-runtime") {
          continue;
        }
        const explicitlyStopped = scenario.given.some(
          (candidate) =>
            candidate.kind === "stack" &&
            candidate.stackId === fact.stackId &&
            candidate.lifecycle === "stopped",
        );
        if (!explicitlyStopped) {
          errors.push(
            `${scenario.id}: persisted runtime failure for ${fact.stackId} requires an explicit stopped lifecycle`,
          );
        }
      }
    }

    for (const write of scenario.expected.writes) {
      if (
        write.operation === "copy" ||
        write.operation === "create" ||
        write.operation === "publish"
      ) {
        declaredIds.add(write.id);
      }
      if (write.target === "identity-marker") {
        declaredIds.add(write.projectId);
        declaredIds.add(write.checkoutId);
        declaredIds.add(write.contextId);
        projectIds.add(write.projectId);
        checkoutIds.add(write.checkoutId);
        contextIds.add(write.contextId);
      }
    }
    for (const write of scenario.expected.writes) {
      if (
        write.operation !== "copy" &&
        write.operation !== "create" &&
        write.operation !== "publish" &&
        !declaredIds.has(write.id)
      ) {
        errors.push(
          `${scenario.id}: ${write.target} ${write.operation} references undeclared ID ${write.id}`,
        );
      }
    }

    const selection = scenario.expected.selection;
    if (selection !== undefined) {
      projectIds.add(selection.projectId);
      checkoutIds.add(selection.checkoutId);
      contextIds.add(selection.contextId);
      for (const id of [
        selection.projectId,
        selection.checkoutId,
        selection.contextId,
        selection.stackId,
      ]) {
        if (!declaredIds.has(id)) {
          errors.push(`${scenario.id}: selection references undeclared ID ${id}`);
        }
      }

      const selectedStack = scenario.given.find(
        (fact) => fact.kind === "stack" && fact.stackId === selection.stackId,
      );
      if (selectedStack?.kind === "stack") {
        if (selectedStack.contextId !== selection.contextId) {
          errors.push(
            `${scenario.id}: selected stack ${selection.stackId} belongs to context ${selectedStack.contextId}, not ${selection.contextId}`,
          );
        }
        if (selectedStack.name !== selection.stackName) {
          errors.push(
            `${scenario.id}: selected stack ${selection.stackId} is named ${selectedStack.name}, not ${selection.stackName}`,
          );
        }
      }

      const actionCheckout = scenario.given.find(
        (fact) => fact.kind === "checkout" && fact.path === actionCwd,
      );
      if (
        actionCheckout?.kind === "checkout" &&
        (selection.projectId !== actionCheckout.projectId ||
          selection.checkoutId !== actionCheckout.checkoutId)
      ) {
        errors.push(
          `${scenario.id}: selection must use checkout ${actionCheckout.checkoutId} for ${actionCwd}`,
        );
      }

      if (checkedOutBranch?.kind === "branch") {
        const createsSelectedContext = scenario.expected.writes.some(
          (write) =>
            write.target === "git-config" &&
            write.operation === "create" &&
            write.id === selection.contextId,
        );
        const hasCheckoutScopedContextClaim = scenario.given.some(
          (fact) =>
            fact.kind === "identity-claim" &&
            fact.scope === "context" &&
            fact.id === selection.contextId &&
            fact.status === "exact" &&
            (fact.owner === checkedOutBranch.name ||
              fact.owner === `${selection.checkoutId}/${checkedOutBranch.name}`),
        );
        if (
          (actionGitState?.kind === "git-state" &&
            actionGitState.head === "branch" &&
            actionGitState.branch !== checkedOutBranch.name) ||
          (selection.contextId !== checkedOutBranch.contextId &&
            !createsSelectedContext &&
            !hasCheckoutScopedContextClaim)
        ) {
          errors.push(
            `${scenario.id}: selected context must match the active Git branch and checked-out branch fact`,
          );
        }
      }

      if (scenario.when.interface === "managed-api" && scenario.when.method === "resolveStack") {
        for (const write of scenario.expected.writes) {
          if (write.target !== "git-config" || write.operation !== "create") {
            continue;
          }
          const scope =
            write.id === selection.projectId
              ? "project"
              : write.id === selection.checkoutId
                ? "checkout"
                : write.id === selection.contextId
                  ? "context"
                  : undefined;
          if (
            scope !== undefined &&
            !scenario.given.some(
              (fact) =>
                fact.kind === "identity-claim" &&
                fact.scope === scope &&
                fact.id === write.id &&
                fact.status === "absent",
            )
          ) {
            errors.push(
              `${scenario.id}: creating Git identity ${write.id} requires an absent ${scope} claim`,
            );
          }
        }
      }

      if (
        scenario.given.some(
          (fact) => fact.kind === "identity-transition" && fact.operation === "folder-to-git",
        )
      ) {
        for (const id of [selection.projectId, selection.checkoutId, selection.contextId]) {
          if (
            !scenario.expected.writes.some(
              (write) => write.target === "git-config" && write.id === id,
            )
          ) {
            errors.push(
              `${scenario.id}: folder-to-Git identity ${id} must be persisted in Git-local metadata`,
            );
          }
        }
        if (
          scenario.expected.outcome === "reuse" &&
          (!scenario.given.some(
            (fact) =>
              fact.kind === "identity-claim" &&
              fact.scope === "project" &&
              fact.id === selection.projectId &&
              fact.path === actionCwd &&
              fact.status === "exact",
          ) ||
            !scenario.given.some(
              (fact) =>
                fact.kind === "identity-claim" &&
                fact.scope === "checkout" &&
                fact.id === selection.checkoutId &&
                fact.path === actionCwd &&
                fact.status === "exact",
            ))
        ) {
          errors.push(
            `${scenario.id}: folder-to-Git reuse requires exact project and checkout claims`,
          );
        }
      }

      const createsSelectedContext = scenario.expected.writes.some(
        (write) =>
          write.target === "git-config" &&
          write.operation === "create" &&
          write.id === selection.contextId,
      );
      const derivesContextFromGit = scenario.given.some(
        (fact) =>
          fact.kind === "identity-transition" &&
          (fact.operation === "clone" ||
            fact.operation === "branch-delete-recreate" ||
            fact.operation === "folder-to-git" ||
            fact.operation === "ref-replacement"),
      );
      const contextAlreadyDeclaredByBranch = scenario.given.some(
        (fact) =>
          fact.kind === "branch" && fact.contextId === selection.contextId && fact.checkedOut,
      );
      if (
        createsSelectedContext &&
        derivesContextFromGit &&
        !contextAlreadyDeclaredByBranch &&
        (actionCwd === undefined ||
          !scenario.given.some(
            (fact) => fact.kind === "git-state" && fact.workspacePath === actionCwd,
          ))
      ) {
        errors.push(`${scenario.id}: creating a Git context requires Git state for the workspace`);
      }

      const ordinaryWorkspace = scenario.given.find(
        (fact) =>
          fact.kind === "workspace" &&
          fact.mode === "ordinary-folder" &&
          (fact.path === actionCwd || fact.canonicalPath === actionCwd),
      );
      if (ordinaryWorkspace?.kind === "workspace") {
        if (scenario.expected.outcome === "create") {
          if (
            !scenario.expected.writes.some(
              (write) =>
                write.target === "identity-marker" &&
                write.workspacePath === actionCwd &&
                write.projectId === selection.projectId &&
                write.checkoutId === selection.checkoutId &&
                write.contextId === selection.contextId,
            )
          ) {
            errors.push(
              `${scenario.id}: ordinary-folder creation must persist its identity marker`,
            );
          }
        } else if (
          !scenario.given.some(
            (fact) =>
              fact.kind === "identity-marker" &&
              fact.workspacePath === actionCwd &&
              fact.projectId === selection.projectId &&
              fact.checkoutId === selection.checkoutId &&
              fact.contextId === selection.contextId,
          )
        ) {
          errors.push(`${scenario.id}: ordinary-folder reuse must resolve its identity marker`);
        }
      }
    }

    if (scenario.when.interface === "managed-api" && scenario.when.method === "startConcurrently") {
      const concurrencyFacts = scenario.given.filter(
        (fact) => fact.kind === "concurrent-operation" && fact.operation === "create-stack",
      );
      const concurrencyFact = concurrencyFacts.length === 1 ? concurrencyFacts[0] : undefined;
      if (concurrencyFact?.kind !== "concurrent-operation") {
        errors.push(`${scenario.id}: concurrent start requires exactly one create-stack fact`);
      } else {
        const actionContenders = scenario.when.input.contenders;
        if (
          typeof actionContenders !== "number" ||
          !Number.isInteger(actionContenders) ||
          actionContenders < 2 ||
          actionContenders !== concurrencyFact.contenders
        ) {
          errors.push(
            `${scenario.id}: concurrent action contenders must match the declared race of ${concurrencyFact.contenders}`,
          );
        }

        const actionStackName = scenario.when.input.stackName;
        const actionTarget =
          selection !== undefined && typeof actionStackName === "string"
            ? `${selection.contextId}/${actionStackName}`
            : undefined;
        if (actionTarget !== concurrencyFact.target) {
          errors.push(
            `${scenario.id}: concurrent action target must match ${concurrencyFact.target}`,
          );
        }

        const contenderResults = [
          {
            projection: "details",
            results: scenario.expected.details?.contender_results,
          },
          {
            projection: "API",
            results: scenario.expected.output.api?.contenderResults,
          },
        ];
        for (const { projection, results } of contenderResults) {
          if (!Array.isArray(results) || results.length !== concurrencyFact.contenders) {
            errors.push(
              `${scenario.id}: concurrent ${projection} results must cover ${concurrencyFact.contenders} contenders`,
            );
          }
        }
        const detailResults = scenario.expected.details?.contender_results;
        const apiResults = scenario.expected.output.api?.contenderResults;
        if (
          Array.isArray(detailResults) &&
          Array.isArray(apiResults) &&
          !managedStackContractJsonEquals(detailResults, apiResults)
        ) {
          errors.push(`${scenario.id}: concurrent result projections must agree`);
        }
        if (
          Array.isArray(detailResults) &&
          (detailResults.filter((result) => result === "create").length !== 1 ||
            detailResults.some((result) => result !== "create" && result !== "reuse"))
        ) {
          errors.push(`${scenario.id}: concurrent race must create once and reuse thereafter`);
        }
        if (
          scenario.expected.details?.published_stack_count !== 1 ||
          scenario.expected.output.api?.publishedStackCount !== 1 ||
          scenario.expected.details?.alias_count !== 0 ||
          scenario.expected.output.api?.aliasCount !== 0
        ) {
          errors.push(`${scenario.id}: concurrent race must publish one stack without aliases`);
        }
      }
    }

    if (scenario.expected.error?.code === "exact_port_occupied") {
      const configuredPort = scenario.given.find(
        (fact) => fact.kind === "config-port" && fact.intent === "exact",
      );
      const occupiedPort =
        configuredPort?.kind === "config-port"
          ? scenario.given.find(
              (fact) => fact.kind === "occupied-port" && fact.port === configuredPort.value,
            )
          : undefined;
      if (
        configuredPort?.kind !== "config-port" ||
        typeof configuredPort.value !== "number" ||
        occupiedPort?.kind !== "occupied-port" ||
        output.human?.fields.port !== String(configuredPort.value) ||
        output.human?.fields.configKey !== configuredPort.key ||
        output.human?.fields.owner !== occupiedPort.owner ||
        output.json?.port !== configuredPort.value ||
        output.json?.config_key !== configuredPort.key ||
        output.json?.owner !== occupiedPort.owner
      ) {
        errors.push(
          `${scenario.id}: exact port conflict must bind config, occupancy, and projections`,
        );
      }
    }

    const managedPortOwners = scenario.given.flatMap((fact) =>
      fact.kind === "occupied-port" && fact.owner === "managed-stack" ? [fact] : [],
    );
    if (scenario.expected.error?.code === "exact_port_occupied" && managedPortOwners.length > 0) {
      if (selection === undefined) {
        errors.push(`${scenario.id}: managed sibling port conflict requires a selected target`);
      }
      for (const owner of managedPortOwners) {
        if (owner.ownerId.trim().length === 0) {
          errors.push(`${scenario.id}: managed sibling port owner requires a stack ID`);
        }
        if (owner.ownerId === selection?.stackId) {
          errors.push(
            `${scenario.id}: managed sibling port owner must differ from the selected target`,
          );
        }
        if (
          (output.json !== undefined && output.json.owner_stack_id !== owner.ownerId) ||
          (output.api !== undefined && output.api.ownerStackId !== owner.ownerId) ||
          (output.human !== undefined && output.human.fields.ownerStackId !== owner.ownerId)
        ) {
          errors.push(`${scenario.id}: projected managed port owner must match ${owner.ownerId}`);
        }
      }
    }

    if (scenario.expected.error?.code === "sticky_port_occupied") {
      if (selection === undefined) {
        errors.push(`${scenario.id}: sticky port conflict requires a selected target`);
      } else {
        const assignment = scenario.given.find(
          (fact) =>
            fact.kind === "port-assignment" &&
            fact.stackId === selection.stackId &&
            fact.intent === "automatic",
        );
        const occupiedPort =
          assignment?.kind === "port-assignment"
            ? scenario.given.find(
                (fact) => fact.kind === "occupied-port" && fact.port === assignment.port,
              )
            : undefined;
        if (
          assignment?.kind !== "port-assignment" ||
          occupiedPort?.kind !== "occupied-port" ||
          output.json?.port !== assignment.port ||
          output.json?.config_key !== assignment.key ||
          output.json?.relocated !== false
        ) {
          errors.push(
            `${scenario.id}: sticky port conflict must bind assignment, occupancy, and projections`,
          );
        }
        if (
          !scenario.given.some(
            (fact) =>
              fact.kind === "stack" &&
              fact.stackId === selection.stackId &&
              fact.lifecycle === "stopped",
          )
        ) {
          errors.push(`${scenario.id}: sticky port conflict requires a stopped selected stack`);
        }
      }
    }

    const changedExactPort = scenario.given.find(
      (fact) =>
        fact.kind === "config-port" &&
        fact.intent === "exact" &&
        typeof fact.value === "number" &&
        typeof fact.previousValue === "number",
    );
    const expectsExactPortChange =
      (scenario.expected.outcome === "update" &&
        typeof output.json?.previous_port === "number" &&
        typeof output.json?.port === "number") ||
      scenario.expected.warning?.code === "running_stack_config_drift";
    if (expectsExactPortChange) {
      let exactPortChangeMatches = false;
      if (
        changedExactPort?.kind === "config-port" &&
        typeof changedExactPort.value === "number" &&
        typeof changedExactPort.previousValue === "number"
      ) {
        const previousAssignment = scenario.given.find(
          (fact) =>
            fact.kind === "port-assignment" &&
            fact.stackId === selection?.stackId &&
            fact.key === changedExactPort.key &&
            fact.port === changedExactPort.previousValue,
        );
        const updateProjectionMatches =
          scenario.expected.outcome !== "update" ||
          (output.json?.previous_port === changedExactPort.previousValue &&
            output.json?.port === changedExactPort.value &&
            output.human?.fields.apiUrl === `http://127.0.0.1:${changedExactPort.value}`);
        const driftProjectionMatches =
          scenario.expected.warning?.code !== "running_stack_config_drift" ||
          (scenario.given.some(
            (fact) =>
              fact.kind === "stack" &&
              fact.stackId === selection?.stackId &&
              fact.lifecycle === "running",
          ) &&
            output.json?.config_key === changedExactPort.key &&
            output.json?.running_port === changedExactPort.previousValue &&
            output.json?.requested_port === changedExactPort.value &&
            output.human?.fields.configKey === changedExactPort.key &&
            output.human?.fields.runningPort === String(changedExactPort.previousValue) &&
            output.human?.fields.configuredPort === String(changedExactPort.value));
        exactPortChangeMatches =
          previousAssignment?.kind === "port-assignment" &&
          previousAssignment.intent === "exact" &&
          changedExactPort.value !== changedExactPort.previousValue &&
          updateProjectionMatches &&
          driftProjectionMatches;
      }
      if (!exactPortChangeMatches) {
        errors.push(
          `${scenario.id}: exact port change must bind previous assignment and requested value`,
        );
      }
    }

    if (scenario.expected.output.json?.sticky === true) {
      if (selection === undefined) {
        errors.push(`${scenario.id}: sticky port reuse requires a selected target`);
      } else if (
        !scenario.given.some(
          (fact) => fact.kind === "port-assignment" && fact.stackId === selection.stackId,
        )
      ) {
        errors.push(`${scenario.id}: reused sticky port must belong to the selected target`);
      }
    }

    if (
      scenario.area === "ports" &&
      scenario.when.interface === "managed-api" &&
      scenario.when.method === "startStack" &&
      scenario.expected.outcome === "create"
    ) {
      const targetStackId = scenario.when.input.stackId;
      const siblingAssignments = scenario.given.flatMap((fact) =>
        fact.kind === "port-assignment" &&
        typeof targetStackId === "string" &&
        fact.stackId !== targetStackId
          ? [fact]
          : [],
      );
      if (siblingAssignments.length > 0) {
        const projectedPorts = scenario.expected.output.api?.ports;
        if (!isManagedStackContractRecord(projectedPorts)) {
          errors.push(`${scenario.id}: sibling allocation must project its allocated ports`);
        } else {
          const occupiedSiblingPorts = new Set(siblingAssignments.map(({ port }) => port));
          const allocatedPorts = new Set<number>();
          for (const port of Object.values(projectedPorts)) {
            if (typeof port === "number") {
              if (allocatedPorts.has(port)) {
                errors.push(`${scenario.id}: allocated port ${port} is assigned more than once`);
              }
              allocatedPorts.add(port);
              if (occupiedSiblingPorts.has(port)) {
                errors.push(
                  `${scenario.id}: allocated port ${port} conflicts with a sibling target`,
                );
              }
            }
          }
        }
      }
    }

    if (
      scenario.when.interface === "managed-api" &&
      scenario.when.method === "startStack" &&
      isManagedStackContractRecord(scenario.when.input.portIntents)
    ) {
      const projectedPorts = scenario.expected.output.api?.ports;
      const projectedIntents = scenario.expected.output.api?.intents;
      const requestedEntries = Object.entries(scenario.when.input.portIntents);
      const configPorts = scenario.given.filter((fact) => fact.kind === "config-port");
      if (
        !managedStackContractStringSetEquals(
          requestedEntries.map(([key]) => key),
          configPorts.map(({ key }) => key),
        )
      ) {
        errors.push(`${scenario.id}: requested port keys must match their config facts`);
      }
      for (const [key, intent] of requestedEntries) {
        const configPort = scenario.given.find(
          (fact) => fact.kind === "config-port" && fact.key === key,
        );
        const service = key.endsWith(".port") ? key.slice(0, -".port".length) : key;
        if (intent === "automatic") {
          if (
            configPort?.kind !== "config-port" ||
            configPort.intent !== "automatic" ||
            !isManagedStackContractRecord(projectedPorts) ||
            typeof projectedPorts[service] !== "number" ||
            !isManagedStackContractRecord(projectedIntents) ||
            projectedIntents[service] !== "automatic"
          ) {
            errors.push(
              `${scenario.id}: automatic port request ${key} must match its fact and projected allocation`,
            );
          }
          continue;
        }
        if (!isManagedStackContractRecord(intent) || intent.intent !== "exact") {
          errors.push(`${scenario.id}: port request ${key} has an invalid intent`);
          continue;
        }
        const requestedPort = intent.port;
        if (
          typeof requestedPort !== "number" ||
          configPort?.kind !== "config-port" ||
          configPort.intent !== "exact" ||
          configPort.value !== requestedPort
        ) {
          errors.push(`${scenario.id}: exact port request ${key} must match its config fact`);
        } else if (
          !isManagedStackContractRecord(projectedPorts) ||
          projectedPorts[service] !== requestedPort
        ) {
          errors.push(
            `${scenario.id}: projected exact port ${key} must match request ${requestedPort}`,
          );
        }
      }
    }

    if (scenario.expected.error?.code === "runtime_conflicts_with_persisted_stack") {
      if (selection === undefined) {
        errors.push(`${scenario.id}: persisted runtime conflict requires a selected target`);
      } else {
        const persistedRuntime = scenario.given.find(
          (fact) => fact.kind === "persisted-runtime" && fact.stackId === selection.stackId,
        );
        const requestedRuntime =
          explicitRuntime === "docker" || explicitRuntime === "native"
            ? explicitRuntime
            : runtimeRequests.find(
                (fact) =>
                  (fact.source === "cli" || fact.source === "managed-api") &&
                  fact.runtime !== "auto",
              )?.runtime;
        if (persistedRuntime?.kind !== "persisted-runtime") {
          errors.push(`${scenario.id}: persisted runtime must belong to the selected target`);
        } else if (
          requestedRuntime === undefined ||
          persistedRuntime.runtime === requestedRuntime ||
          output.human?.fields.persistedRuntime !== persistedRuntime.runtime ||
          output.human?.fields.requestedRuntime !== requestedRuntime ||
          output.json?.persisted_runtime !== persistedRuntime.runtime ||
          output.json?.requested_runtime !== requestedRuntime ||
          output.json?.code !== scenario.expected.error.code
        ) {
          errors.push(
            `${scenario.id}: persisted runtime conflict must bind persisted and requested values`,
          );
        }
      }
    }

    if (scenario.expected.error?.code === "runtime_selection_conflict") {
      const explicitRequest = runtimeRequests.find(
        (fact) => fact.source === "cli" || fact.source === "managed-api",
      );
      const configRequest = runtimeRequests.find((fact) => fact.source === "config");
      if (
        explicitRequest?.kind !== "runtime-request" ||
        configRequest?.kind !== "runtime-request" ||
        explicitRequest.runtime === "auto" ||
        configRequest.runtime === "auto" ||
        explicitRequest.runtime === configRequest.runtime ||
        output.json?.cli_runtime !== explicitRequest.runtime ||
        output.json?.config_runtime !== configRequest.runtime ||
        output.json?.code !== scenario.expected.error.code
      ) {
        errors.push(
          `${scenario.id}: runtime conflict must bind different explicit and configured runtimes`,
        );
      }
    }

    if (
      scenario.expected.error?.code === "docker_unavailable" ||
      scenario.expected.error?.code === "native_unavailable"
    ) {
      const unavailableRuntime = scenario.expected.error.code.startsWith("docker")
        ? "docker"
        : "native";
      const explicitRequest = runtimeRequests.find(
        (fact) =>
          (fact.source === "cli" || fact.source === "managed-api") &&
          fact.runtime === unavailableRuntime,
      );
      const availability = scenario.given.find(
        (fact) => fact.kind === "runtime-availability" && fact.runtime === unavailableRuntime,
      );
      if (
        explicitRequest?.kind !== "runtime-request" ||
        availability?.kind !== "runtime-availability" ||
        availability.available ||
        availability.reason === undefined ||
        output.json?.requested_runtime !== unavailableRuntime ||
        output.json?.reason !== availability.reason ||
        output.json?.fallback_attempted !== false ||
        scenario.expected.details?.fallback_attempted !== false ||
        scenario.expected.runtimeEffects.some((effect) => effect.operation === "start")
      ) {
        errors.push(
          `${scenario.id}: explicit runtime error must bind an unavailable requested runtime`,
        );
      }
    }

    if (scenario.expected.error?.code === "legacy_source_running") {
      const legacySource = scenario.given.find((fact) => fact.kind === "legacy-state");
      if (
        legacySource?.kind !== "legacy-state" ||
        legacySource.lifecycle !== "running" ||
        scenario.expected.writes.length > 0 ||
        scenario.expected.runtimeEffects.length > 0
      ) {
        errors.push(`${scenario.id}: running legacy error requires a running source`);
      }
    }

    if (scenario.expected.error?.code === "legacy_bootstrap_failed") {
      const rollbackStackId =
        scenario.when.interface === "managed-api" && scenario.when.method === "startStack"
          ? scenario.when.input.stackId
          : undefined;
      if (
        scenario.when.interface !== "managed-api" ||
        scenario.when.method !== "startStack" ||
        scenario.when.input.injectCopyFailure !== true ||
        !scenario.expected.writes.some(
          (write) =>
            write.target === "managed-state" &&
            write.operation === "delete" &&
            write.id === rollbackStackId,
        ) ||
        !scenario.expected.runtimeEffects.some(
          (effect) => effect.operation === "delete" && effect.stackId === rollbackStackId,
        )
      ) {
        errors.push(`${scenario.id}: bootstrap rollback requires enabled copy-failure injection`);
      }
      if (
        typeof rollbackStackId !== "string" ||
        !scenario.given.some(
          (fact) =>
            fact.kind === "managed-target" &&
            fact.stackId === rollbackStackId &&
            fact.exists === false,
        ) ||
        scenario.given.some((fact) => fact.kind === "stack" && fact.stackId === rollbackStackId)
      ) {
        errors.push(
          `${scenario.id}: bootstrap rollback requires failure injection against an absent target`,
        );
      }
    }

    const destructivelyDeletesManagedState =
      scenario.expected.writes.some(
        (write) => write.target === "managed-state" && write.operation === "delete",
      ) || scenario.expected.runtimeEffects.some((effect) => effect.operation === "delete");
    if (
      destructivelyDeletesManagedState &&
      scenario.when.interface === "cli" &&
      scenario.when.argv[0] === "stop" &&
      !scenario.when.argv.includes("--no-backup")
    ) {
      errors.push(`${scenario.id}: destructive stop requires --no-backup`);
    }

    if (scenario.expected.details?.idempotent === true || output.json?.already_deleted === true) {
      if (
        typeof explicitActionStackId !== "string" ||
        !scenario.given.some(
          (fact) =>
            fact.kind === "managed-record" &&
            fact.stackId === explicitActionStackId &&
            fact.status === "tombstoned",
        ) ||
        scenario.expected.outcome !== "no-op" ||
        scenario.expected.details?.tombstoned !== true ||
        scenario.expected.details?.idempotent !== true ||
        output.json?.tombstoned !== true ||
        scenario.expected.writes.length > 0 ||
        scenario.expected.runtimeEffects.length > 0
      ) {
        errors.push(`${scenario.id}: idempotent deletion requires a tombstoned target`);
      }
    }

    const globallyTargetedStack = scenario.given.find(
      (fact) => fact.kind === "stack" && fact.stackId === explicitActionStackId,
    );
    if (
      scenario.when.interface === "cli" &&
      scenario.when.argv[0] === "stop" &&
      scenario.when.argv.includes("--stack-id") &&
      scenario.expected.outcome === "delete" &&
      globallyTargetedStack?.kind === "stack" &&
      (globallyTargetedStack.orphaned !== undefined ||
        output.json?.orphaned !== undefined ||
        output.human?.fields.orphaned !== undefined)
    ) {
      if (
        typeof explicitActionStackId !== "string" ||
        globallyTargetedStack.orphaned !== true ||
        output.json?.orphaned !== true ||
        output.human?.fields.orphaned !== "true"
      ) {
        errors.push(`${scenario.id}: global orphan deletion requires an orphaned target`);
      }
    }

    if (
      scenario.given.some((fact) => fact.kind === "credential-state") &&
      scenario.expected.writes.some(
        (write) =>
          write.target === "managed-state" &&
          (write.operation === "copy" ||
            write.operation === "create" ||
            write.operation === "update"),
      ) &&
      scenario.expected.details?.plaintext_secrets_in_global_state !== false
    ) {
      errors.push(`${scenario.id}: credential persistence must not expose plaintext globally`);
    }

    const changedCredentials = scenario.given.find(
      (fact) => fact.kind === "credential-state" && fact.previousValuesId !== undefined,
    );
    if (
      changedCredentials?.kind === "credential-state" &&
      changedCredentials.previousValuesId === changedCredentials.valuesId
    ) {
      errors.push(`${scenario.id}: credential change requires different old and new values`);
    }
    if (
      changedCredentials?.kind === "credential-state" &&
      scenario.expected.outcome === "update" &&
      (output.json?.previous_credentials_values_id !== changedCredentials.previousValuesId ||
        output.json?.credentials_values_id !== changedCredentials.valuesId ||
        !scenario.expected.writes.some(
          (write) => write.target === "managed-state" && write.operation === "update",
        ))
    ) {
      errors.push(`${scenario.id}: credential update must bind old and new persisted references`);
    }

    if (scenario.expected.warning?.code === "running_stack_credentials_drift") {
      if (
        selection === undefined ||
        changedCredentials?.kind !== "credential-state" ||
        !scenario.given.some(
          (fact) =>
            fact.kind === "stack" &&
            fact.stackId === selection.stackId &&
            fact.lifecycle === "running",
        ) ||
        scenario.expected.outcome !== "report" ||
        scenario.expected.writes.length > 0 ||
        scenario.expected.runtimeEffects.length > 0 ||
        output.json?.stack_id !== selection.stackId ||
        output.json?.drift !== true ||
        output.human?.fields.stackId !== selection.stackId ||
        output.human?.fields.drift !== "true"
      ) {
        errors.push(`${scenario.id}: credential drift report requires a running selected stack`);
      }
    }

    const legacyCredentials = scenario.given.find(
      (fact) => fact.kind === "credential-state" && fact.source === "legacy",
    );
    const copiesManagedCredentials = scenario.expected.writes.some(
      (write) => write.target === "managed-state" && write.operation === "copy",
    );
    if (
      copiesManagedCredentials &&
      (legacyCredentials?.kind === "credential-state" ||
        typeof scenario.expected.details?.credential_values_id === "string" ||
        typeof output.api?.credentialsValuesId === "string") &&
      (legacyCredentials?.kind !== "credential-state" ||
        scenario.expected.details?.credential_values_id !== legacyCredentials.valuesId ||
        output.api?.credentialsValuesId !== legacyCredentials.valuesId)
    ) {
      errors.push(`${scenario.id}: copied legacy credentials must bind their persisted reference`);
    }

    if (scenario.expected.details?.retry_after_rollback === true) {
      const retryStackId =
        scenario.when.interface === "managed-api" && scenario.when.method === "startStack"
          ? scenario.when.input.stackId
          : undefined;
      if (
        typeof retryStackId !== "string" ||
        !scenario.given.some(
          (fact) =>
            fact.kind === "operation-result" &&
            fact.operation === "legacy-bootstrap" &&
            fact.stackId === retryStackId &&
            fact.outcome === "rolled-back",
        )
      ) {
        errors.push(`${scenario.id}: bootstrap retry requires a rolled-back prior attempt`);
      }
    }

    if (
      scenario.when.interface === "cli" &&
      scenario.when.argv[0] === "stack" &&
      scenario.when.argv[1] === "prune" &&
      scenario.expected.details?.mutable_data_deleted === false
    ) {
      for (const write of scenario.expected.writes) {
        if (write.target !== "registry" || write.operation !== "delete") {
          continue;
        }
        const mutableDataExists = scenario.given.some(
          (fact) =>
            (fact.kind === "stack" && fact.stackId === write.id) ||
            (fact.kind === "managed-target" && fact.stackId === write.id && fact.exists),
        );
        if (!mutableDataExists) {
          errors.push(`${scenario.id}: data-preserving prune must declare mutable stack data`);
        }
        const orphanedRecord = scenario.given.some(
          (fact) =>
            fact.kind === "managed-record" &&
            fact.stackId === write.id &&
            fact.status === "orphaned",
        );
        const orphanedStack = scenario.given.some(
          (fact) => fact.kind === "stack" && fact.stackId === write.id && fact.orphaned === true,
        );
        if (!orphanedRecord || !orphanedStack) {
          errors.push(`${scenario.id}: prune may delete only orphaned registry metadata`);
        }
      }
    }

    const activeBranchName =
      actionGitState?.kind === "git-state" && actionGitState.head === "branch"
        ? actionGitState.branch
        : checkedOutBranch?.kind === "branch"
          ? checkedOutBranch.name
          : undefined;

    for (const write of scenario.expected.writes) {
      if (write.target !== "git-config") {
        continue;
      }
      if (write.operation === "create" && existingCheckoutIdentityIds.has(write.id)) {
        errors.push(`${scenario.id}: Git identity ${write.id} is already declared`);
      }
      const expectedScope = projectIds.has(write.id)
        ? "common"
        : checkoutIds.has(write.id) || contextIds.has(write.id)
          ? "worktree"
          : undefined;
      if (expectedScope !== undefined && write.scope !== expectedScope) {
        errors.push(
          `${scenario.id}: Git identity ${write.id} must use ${expectedScope} config scope`,
        );
      }
      if (contextIds.has(write.id)) {
        if (write.owner === undefined) {
          errors.push(`${scenario.id}: Git context ${write.id} must declare its branch owner`);
        } else if (activeBranchName !== undefined && write.owner !== activeBranchName) {
          errors.push(
            `${scenario.id}: Git context ${write.id} must belong to branch ${activeBranchName}`,
          );
        }
      }
    }

    for (const effect of scenario.expected.runtimeEffects) {
      if (!declaredIds.has(effect.stackId)) {
        errors.push(`${scenario.id}: runtime effect references undeclared ID ${effect.stackId}`);
      }

      if (
        effect.operation === "stop" &&
        !scenario.given.some(
          (fact) =>
            fact.kind === "stack" &&
            fact.stackId === effect.stackId &&
            fact.lifecycle === "running",
        )
      ) {
        errors.push(
          `${scenario.id}: stopping stack ${effect.stackId} requires a running lifecycle`,
        );
      }

      const hasWrite = scenario.expected.writes.some((write) => {
        if (write.id !== effect.stackId) {
          return false;
        }
        switch (effect.operation) {
          case "copy":
            return write.target === "managed-state" && write.operation === "copy";
          case "delete":
            return write.target === "managed-state" && write.operation === "delete";
          case "start":
            return write.target === "runtime-state" && write.operation === "start";
          case "stop":
            return (
              write.target === "runtime-state" &&
              (write.operation === "delete" || write.operation === "update")
            );
        }
      });
      if (!hasWrite) {
        errors.push(
          `${scenario.id}: ${effect.operation} runtime effect requires a matching state write`,
        );
      }
    }

    for (const write of scenario.expected.writes) {
      if (
        write.target === "managed-state" &&
        (write.operation === "copy" || write.operation === "create") &&
        !scenario.expected.writes.some(
          (candidate) =>
            candidate.target === "registry" &&
            candidate.operation === "publish" &&
            candidate.id === write.id,
        )
      ) {
        errors.push(
          `${scenario.id}: managed-state ${write.operation} requires registry publication`,
        );
      }

      if (
        write.target === "registry" &&
        write.operation === "publish" &&
        !scenario.expected.writes.some(
          (candidate) =>
            candidate.target === "managed-state" &&
            (candidate.operation === "create" || candidate.operation === "copy") &&
            candidate.id === write.id,
        )
      ) {
        errors.push(`${scenario.id}: registry publication requires managed-state creation or copy`);
      }

      if (
        scenario.expected.outcome === "delete" &&
        write.target === "managed-state" &&
        write.operation === "delete" &&
        !scenario.expected.writes.some(
          (candidate) =>
            candidate.target === "registry" &&
            candidate.operation === "tombstone" &&
            candidate.id === write.id,
        )
      ) {
        errors.push(`${scenario.id}: managed-state deletion requires a registry tombstone`);
      }

      if (
        write.target === "registry" &&
        write.operation === "tombstone" &&
        !scenario.expected.writes.some(
          (candidate) =>
            candidate.target === "managed-state" &&
            candidate.operation === "delete" &&
            candidate.id === write.id,
        )
      ) {
        errors.push(`${scenario.id}: registry tombstone requires managed-state deletion`);
      }

      const requiredRuntimeOperation =
        write.target === "runtime-state" && write.operation === "start"
          ? "start"
          : write.target === "runtime-state" &&
              (write.operation === "delete" || write.operation === "update")
            ? "stop"
            : write.target === "managed-state" && write.operation === "copy"
              ? "copy"
              : write.target === "managed-state" && write.operation === "delete"
                ? "delete"
                : undefined;
      if (
        requiredRuntimeOperation !== undefined &&
        !scenario.expected.runtimeEffects.some(
          (effect) => effect.operation === requiredRuntimeOperation && effect.stackId === write.id,
        )
      ) {
        errors.push(
          `${scenario.id}: ${write.target} ${write.operation} requires a matching runtime effect`,
        );
      }
    }

    const checkProjection = (
      projection: Readonly<Record<string, ManagedStackContractJson>> | undefined,
      key: string,
      expected: ManagedStackContractJson,
    ): void => {
      if (projection?.[key] !== undefined && projection[key] !== expected) {
        errors.push(`${scenario.id}: projected ${key} disagrees with the managed result`);
      }
    };

    if (
      scenario.expected.output.json !== undefined &&
      scenario.expected.output.json.outcome === undefined
    ) {
      errors.push(`${scenario.id}: JSON projection requires an outcome`);
    }
    const structuredCode = scenario.expected.error?.code ?? scenario.expected.warning?.code;
    if (
      scenario.expected.output.json !== undefined &&
      structuredCode !== undefined &&
      scenario.expected.output.json.code === undefined
    ) {
      errors.push(`${scenario.id}: JSON projection requires a code`);
    }
    for (const projection of [scenario.expected.output.json, scenario.expected.output.api]) {
      checkProjection(projection, "outcome", scenario.expected.outcome);
      if (scenario.expected.error !== undefined) {
        checkProjection(projection, "code", scenario.expected.error.code);
      }
      if (scenario.expected.warning !== undefined) {
        checkProjection(projection, "code", scenario.expected.warning.code);
      }
    }
    if (selection !== undefined) {
      checkProjection(scenario.expected.output.json, "project_id", selection.projectId);
      checkProjection(scenario.expected.output.json, "checkout_id", selection.checkoutId);
      checkProjection(scenario.expected.output.json, "context_id", selection.contextId);
      checkProjection(scenario.expected.output.json, "stack_id", selection.stackId);
      checkProjection(scenario.expected.output.json, "stack_name", selection.stackName);
      checkProjection(scenario.expected.output.api, "projectId", selection.projectId);
      checkProjection(scenario.expected.output.api, "checkoutId", selection.checkoutId);
      checkProjection(scenario.expected.output.api, "contextId", selection.contextId);
      checkProjection(scenario.expected.output.api, "stackId", selection.stackId);
      checkProjection(scenario.expected.output.api, "stackName", selection.stackName);
      checkProjection(scenario.expected.output.human?.fields, "projectId", selection.projectId);
      checkProjection(scenario.expected.output.human?.fields, "checkoutId", selection.checkoutId);
      checkProjection(scenario.expected.output.human?.fields, "contextId", selection.contextId);
      checkProjection(scenario.expected.output.human?.fields, "stackId", selection.stackId);
      checkProjection(scenario.expected.output.human?.fields, "stack", selection.stackName);
      checkProjection(scenario.expected.output.human?.fields, "stackName", selection.stackName);

      const selectedBranch = scenario.given.find(
        (fact) =>
          fact.kind === "branch" && fact.checkedOut && fact.contextId === selection.contextId,
      );
      if (selectedBranch?.kind === "branch") {
        checkProjection(scenario.expected.output.human?.fields, "branch", selectedBranch.name);
      }
    }

    const expectedRecovery =
      scenario.expected.error?.recovery ?? scenario.expected.warning?.recovery;
    const humanOutput = scenario.expected.output.human;
    if (
      humanOutput !== undefined &&
      expectedRecovery !== undefined &&
      (humanOutput.recovery === undefined ||
        humanOutput.recovery.length !== expectedRecovery.length ||
        humanOutput.recovery.some((step, index) => step !== expectedRecovery[index]))
    ) {
      errors.push(`${scenario.id}: human recovery disagrees with the managed result`);
    }
    const jsonOutput = scenario.expected.output.json;
    const jsonRecovery = jsonOutput?.recovery;
    if (
      jsonOutput !== undefined &&
      expectedRecovery !== undefined &&
      (!Array.isArray(jsonRecovery) ||
        jsonRecovery.length !== expectedRecovery.length ||
        jsonRecovery.some((step, index) => step !== expectedRecovery[index]))
    ) {
      errors.push(`${scenario.id}: JSON recovery disagrees with the managed result`);
    }
  }

  return errors;
};

const branchHistoryFixture = (
  label: "commit" | "rebase" | "reset",
  operation: "branch-commit" | "branch-rebase" | "branch-reset",
): ManagedStackContractScenario => ({
  id: `identity.branch-${label}-preserves-context`,
  title: `A branch ${label} preserves its context and stack`,
  area: "identity",
  given: [
    { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
    { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: true },
    { kind: "identity-transition", operation, from: "commit-a", to: "commit-b" },
    {
      kind: "stack",
      name: "default",
      stackId: "stack-feat-default",
      contextId: "context-feat",
      lifecycle: "stopped",
    },
  ],
  when: {
    interface: "managed-api",
    method: "resolveStack",
    input: { cwd: "checkout-a", stackName: "default", operation: "start" },
  },
  expected: {
    outcome: "reuse",
    selection: {
      projectId: "project-a",
      checkoutId: "checkout-a",
      contextId: "context-feat",
      stackId: "stack-feat-default",
      stackName: "default",
    },
    writes: [{ target: "runtime-state", operation: "start", id: "stack-feat-default" }],
    runtimeEffects: [{ operation: "start", stackId: "stack-feat-default" }],
    output: { api: { outcome: "reuse", contextId: "context-feat", stackId: "stack-feat-default" } },
  },
});

const invalidStackNameFixture = (
  label: "leading-hyphen" | "repeated-dot" | "uppercase-underscore",
  stackName: string,
): ManagedStackContractScenario => ({
  id: `identity.invalid-stack-name-${label}-fails`,
  title: `The invalid stack name ${stackName} fails before registration`,
  area: "identity",
  given: [{ kind: "stack-names", names: [stackName] }],
  when: {
    interface: "cli",
    argv: ["start", "--experimental", "--stack", stackName],
    cwd: "checkout-a",
  },
  expected: {
    outcome: "error",
    error: {
      code: "invalid_stack_name",
      message: `${stackName} is not a lowercase DNS-label name`,
      recovery: ["Use default or a lowercase DNS-label name such as feature-a"],
    },
    writes: [],
    runtimeEffects: [],
    output: {
      human: {
        summary: `Invalid stack name: ${stackName}`,
        fields: { stack: stackName },
        recovery: ["Use default or a lowercase DNS-label name such as feature-a"],
      },
      json: {
        outcome: "error",
        code: "invalid_stack_name",
        stack_name: stackName,
        recovery: ["Use default or a lowercase DNS-label name such as feature-a"],
      },
    },
  },
});

const mainCheckoutContextFacts = [
  { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
  { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
] satisfies ReadonlyArray<ManagedStackContractFact>;

const freshManagedStartFacts = (stackId: string): ReadonlyArray<ManagedStackContractFact> => [
  { kind: "managed-target", stackId, exists: false },
  {
    kind: "legacy-state",
    lifecycle: "absent",
    database: "absent",
    storage: "absent",
    credentials: "absent",
  },
];

const freshMainManagedStartFacts = freshManagedStartFacts("stack-main-default");

const mainDefaultSelection = {
  projectId: "project-a",
  checkoutId: "checkout-a",
  contextId: "context-main",
  stackId: "stack-main-default",
  stackName: "default",
};

const additionalIdentityContractFixtures = defineManagedStackContractFixtures([
  {
    id: "identity.same-checkout-branch-and-name-reuses-stack",
    title: "The same checkout, branch, and stack name resolve the same stack",
    area: "identity",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "running",
      },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStack",
      input: { cwd: "checkout-a", stackName: "default", operation: "status" },
    },
    expected: {
      outcome: "report",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [],
      runtimeEffects: [],
      output: {
        api: {
          outcome: "report",
          projectId: "project-a",
          checkoutId: "checkout-a",
          contextId: "context-main",
          stackId: "stack-main-default",
          stackName: "default",
        },
      },
    },
  },
  {
    id: "identity.branch-create-and-switch-is-no-op",
    title: "Creating and switching Git branches alone does not touch managed state",
    area: "identity",
    given: [
      { kind: "workspace", mode: "git", path: "checkout-a" },
      {
        kind: "git-state",
        workspacePath: "checkout-a",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git",
        head: "branch",
        branch: "main",
        commit: "commit-a",
      },
    ],
    when: {
      interface: "git",
      argv: ["switch", "-c", "feat-a"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "no-op",
      writes: [],
      runtimeEffects: [],
      details: { managed_command_ran: false },
      output: {
        human: { summary: "Switched to a new branch 'feat-a'", fields: {} },
      },
    },
  },
  {
    id: "identity.new-branch-first-start-creates-stack",
    title: "First start on a new branch creates an independent context and stack",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-feat-a-default"),
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: false },
      {
        kind: "git-state",
        workspacePath: "checkout-a",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git",
        head: "branch",
        branch: "feat-a",
        commit: "commit-a",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-feat-a",
        stackId: "stack-feat-a-default",
        stackName: "default",
      },
      writes: [
        {
          target: "git-config",
          operation: "create",
          id: "context-feat-a",
          scope: "worktree",
          owner: "feat-a",
        },
        { target: "registry", operation: "publish", id: "stack-feat-a-default" },
        { target: "managed-state", operation: "create", id: "stack-feat-a-default" },
        { target: "runtime-state", operation: "start", id: "stack-feat-a-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-feat-a-default" }],
      output: {
        human: {
          summary: "Created feat-a/default",
          fields: { branch: "feat-a", stack: "default", stackId: "stack-feat-a-default" },
        },
        json: {
          outcome: "create",
          context_id: "context-feat-a",
          stack_id: "stack-feat-a-default",
        },
      },
    },
  },
  {
    id: "identity.branch-rename-preserves-context",
    title: "A standard branch rename preserves its context and stack",
    area: "identity",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: true },
      { kind: "identity-transition", operation: "branch-rename", from: "feature", to: "feat-a" },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-feat-default",
        contextId: "context-feat",
        lifecycle: "stopped",
      },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStack",
      input: { cwd: "checkout-a", stackName: "default", operation: "start" },
    },
    expected: {
      outcome: "reuse",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-feat",
        stackId: "stack-feat-default",
        stackName: "default",
      },
      writes: [
        {
          target: "git-config",
          operation: "update",
          id: "context-feat",
          scope: "worktree",
          owner: "feat-a",
        },
        { target: "runtime-state", operation: "start", id: "stack-feat-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-feat-default" }],
      output: {
        api: { outcome: "reuse", contextId: "context-feat", stackId: "stack-feat-default" },
      },
    },
  },
  {
    id: "identity.branch-delete-recreate-creates-context",
    title: "Deleting and recreating a branch name creates a new context",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-new-default"),
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      {
        kind: "git-state",
        workspacePath: "checkout-a",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git",
        head: "branch",
        branch: "feat-a",
        commit: "commit-new",
      },
      {
        kind: "identity-transition",
        operation: "branch-delete-recreate",
        from: "feat-a",
        to: "feat-a",
      },
      {
        kind: "identity-claim",
        scope: "context",
        id: "context-old",
        owner: "feat-a",
        status: "absent",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-new",
        stackId: "stack-new-default",
        stackName: "default",
      },
      writes: [
        {
          target: "git-config",
          operation: "create",
          id: "context-new",
          scope: "worktree",
          owner: "feat-a",
        },
        { target: "registry", operation: "publish", id: "stack-new-default" },
        { target: "managed-state", operation: "create", id: "stack-new-default" },
        { target: "runtime-state", operation: "start", id: "stack-new-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-new-default" }],
      details: { orphaned_context_id: "context-old" },
      output: {
        json: {
          outcome: "create",
          context_id: "context-new",
          stack_id: "stack-new-default",
          orphaned_context_id: "context-old",
        },
      },
    },
  },
  branchHistoryFixture("commit", "branch-commit"),
  branchHistoryFixture("rebase", "branch-rebase"),
  branchHistoryFixture("reset", "branch-reset"),
  {
    id: "identity.same-commit-different-branches-are-independent",
    title: "Two branches at one commit retain independent contexts",
    area: "identity",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: false },
      { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-feat-default",
        contextId: "context-feat",
        lifecycle: "running",
      },
      {
        kind: "git-state",
        workspacePath: "checkout-a",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git",
        head: "branch",
        branch: "feat-a",
        commit: "shared-commit",
      },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStack",
      input: { cwd: "checkout-a", stackName: "default", operation: "status" },
    },
    expected: {
      outcome: "report",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-feat",
        stackId: "stack-feat-default",
        stackName: "default",
      },
      writes: [],
      runtimeEffects: [],
      output: {
        api: {
          outcome: "report",
          contextId: "context-feat",
          stackId: "stack-feat-default",
          otherContextId: "context-main",
        },
      },
    },
  },
  {
    id: "identity.manual-ref-replacement-orphans-context",
    title: "Replacing a branch ref manually creates a new context and orphans the old one",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-new-default"),
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      {
        kind: "identity-transition",
        operation: "ref-replacement",
        from: "commit-a",
        to: "commit-b",
      },
      {
        kind: "git-state",
        workspacePath: "checkout-a",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git",
        head: "branch",
        branch: "feat-a",
        commit: "commit-b",
      },
      {
        kind: "identity-claim",
        scope: "context",
        id: "context-old",
        owner: "feat-a",
        status: "absent",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-new",
        stackId: "stack-new-default",
        stackName: "default",
      },
      writes: [
        {
          target: "git-config",
          operation: "create",
          id: "context-new",
          scope: "worktree",
          owner: "feat-a",
        },
        { target: "registry", operation: "publish", id: "stack-new-default" },
        { target: "managed-state", operation: "create", id: "stack-new-default" },
        { target: "runtime-state", operation: "start", id: "stack-new-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-new-default" }],
      details: { orphaned_context_id: "context-old", adoption_required: true },
      output: {
        json: {
          outcome: "create",
          context_id: "context-new",
          stack_id: "stack-new-default",
          orphaned_context_id: "context-old",
        },
      },
    },
  },
  {
    id: "identity.detached-commits-reuse-checkout-context",
    title: "Different detached commits in one checkout reuse its detached context",
    area: "identity",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "(detached)", contextId: "context-detached", checkedOut: true },
      {
        kind: "identity-transition",
        operation: "detached-commit",
        from: "commit-a",
        to: "commit-b",
      },
      {
        kind: "git-state",
        workspacePath: "checkout-a",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git",
        head: "detached",
        commit: "commit-b",
      },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-detached-default",
        contextId: "context-detached",
        lifecycle: "stopped",
      },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStack",
      input: { cwd: "checkout-a", stackName: "default", operation: "start" },
    },
    expected: {
      outcome: "reuse",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-detached",
        stackId: "stack-detached-default",
        stackName: "default",
      },
      writes: [{ target: "runtime-state", operation: "start", id: "stack-detached-default" }],
      runtimeEffects: [{ operation: "start", stackId: "stack-detached-default" }],
      output: {
        api: { outcome: "reuse", contextId: "context-detached", stackId: "stack-detached-default" },
      },
    },
  },
  {
    id: "identity.non-git-folder-first-start-persists-identity",
    title: "First start in a non-Git folder persists an untracked local identity",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-workspace-default"),
      {
        kind: "workspace",
        mode: "ordinary-folder",
        path: "project-a",
        canonicalPath: "/work/project-a",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "/work/project-a" },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-workspace",
        stackId: "stack-workspace-default",
        stackName: "default",
      },
      writes: [
        {
          target: "identity-marker",
          operation: "create",
          id: "marker-project-a",
          storage: "project-local-untracked",
          workspacePath: "/work/project-a",
          projectId: "project-a",
          checkoutId: "checkout-a",
          contextId: "context-workspace",
        },
        { target: "registry", operation: "publish", id: "stack-workspace-default" },
        { target: "managed-state", operation: "create", id: "stack-workspace-default" },
        { target: "runtime-state", operation: "start", id: "stack-workspace-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-workspace-default" }],
      details: { identity_marker_tracked: false },
      output: {
        json: {
          outcome: "create",
          project_id: "project-a",
          checkout_id: "checkout-a",
          context_id: "context-workspace",
          stack_id: "stack-workspace-default",
        },
      },
    },
  },
  {
    id: "identity.non-git-folder-recovers-persisted-identity",
    title: "A later start in a non-Git folder recovers its persisted local identity",
    area: "identity",
    given: [
      {
        kind: "workspace",
        mode: "ordinary-folder",
        path: "project-a",
        canonicalPath: "/work/project-a",
      },
      {
        kind: "identity-marker",
        markerId: "marker-project-a",
        workspacePath: "/work/project-a",
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-workspace",
        tracked: false,
      },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-workspace-default",
        contextId: "context-workspace",
        lifecycle: "stopped",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "/work/project-a" },
    expected: {
      outcome: "reuse",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-workspace",
        stackId: "stack-workspace-default",
        stackName: "default",
      },
      writes: [{ target: "runtime-state", operation: "start", id: "stack-workspace-default" }],
      runtimeEffects: [{ operation: "start", stackId: "stack-workspace-default" }],
      output: {
        json: {
          outcome: "reuse",
          context_id: "context-workspace",
          stack_id: "stack-workspace-default",
        },
      },
    },
  },
  {
    id: "identity.linked-worktrees-share-project-not-checkout",
    title: "Sibling linked worktrees share a project and use independent checkouts",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-b-main-default"),
      { kind: "workspace", mode: "linked-worktree", path: "worktree-a" },
      { kind: "workspace", mode: "linked-worktree", path: "worktree-b" },
      {
        kind: "git-state",
        workspacePath: "worktree-b",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git/worktrees/worktree-b",
        head: "branch",
        branch: "main",
        commit: "commit-b",
      },
      { kind: "checkout", path: "worktree-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "checkout", path: "worktree-b", projectId: "project-a", checkoutId: "checkout-b" },
      { kind: "identity-claim", scope: "context", id: "context-b-main", status: "absent" },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStack",
      input: { cwd: "worktree-b", stackName: "default", operation: "start" },
    },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-b",
        contextId: "context-b-main",
        stackId: "stack-b-main-default",
        stackName: "default",
      },
      writes: [
        {
          target: "git-config",
          operation: "create",
          id: "context-b-main",
          scope: "worktree",
          owner: "main",
        },
        { target: "registry", operation: "publish", id: "stack-b-main-default" },
        { target: "managed-state", operation: "create", id: "stack-b-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-b-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-b-main-default" }],
      output: {
        api: { projectId: "project-a", checkoutId: "checkout-b", stackId: "stack-b-main-default" },
      },
    },
  },
  {
    id: "identity.same-branch-in-two-worktrees-is-isolated",
    title: "The same branch forced into two worktrees remains checkout-isolated",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-b-main-default"),
      { kind: "checkout", path: "worktree-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "checkout", path: "worktree-b", projectId: "project-a", checkoutId: "checkout-b" },
      { kind: "branch", name: "main", contextId: "context-a-main", checkedOut: true },
      {
        kind: "identity-claim",
        scope: "context",
        id: "context-b-main",
        owner: "checkout-b/main",
        status: "exact",
      },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStack",
      input: { cwd: "worktree-b", stackName: "default", operation: "start" },
    },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-b",
        contextId: "context-b-main",
        stackId: "stack-b-main-default",
        stackName: "default",
      },
      writes: [
        { target: "registry", operation: "publish", id: "stack-b-main-default" },
        { target: "managed-state", operation: "create", id: "stack-b-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-b-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-b-main-default" }],
      output: {
        api: {
          checkoutId: "checkout-b",
          contextId: "context-b-main",
          stackId: "stack-b-main-default",
        },
      },
    },
  },
  {
    id: "identity.named-stacks-are-context-scoped",
    title: "Named stacks are scoped inside the active branch context",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-feat-review"),
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-feat-default",
        contextId: "context-feat",
        lifecycle: "running",
      },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental", "--stack", "review"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-feat",
        stackId: "stack-feat-review",
        stackName: "review",
      },
      writes: [
        { target: "registry", operation: "publish", id: "stack-feat-review" },
        { target: "managed-state", operation: "create", id: "stack-feat-review" },
        { target: "runtime-state", operation: "start", id: "stack-feat-review" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-feat-review" }],
      output: {
        human: {
          summary: "Created feat-a/review",
          fields: { stack: "review", stackId: "stack-feat-review" },
        },
        json: { outcome: "create", context_id: "context-feat", stack_id: "stack-feat-review" },
      },
    },
  },
  {
    id: "identity.moved-checkout-reuses-identity",
    title: "Moving a checkout rebinds its existing identity",
    area: "identity",
    given: [
      {
        kind: "workspace",
        mode: "git",
        path: "/new/project-a",
        canonicalPath: "/new/project-a",
        previousPath: "/old/project-a",
        previousPathAccess: "missing",
      },
      {
        kind: "identity-transition",
        operation: "checkout-move",
        from: "/old/project-a",
        to: "/new/project-a",
      },
      {
        kind: "identity-claim",
        scope: "checkout",
        id: "checkout-a",
        path: "/old/project-a",
        status: "exact",
      },
      {
        kind: "checkout",
        path: "/old/project-a",
        projectId: "project-a",
        checkoutId: "checkout-a",
      },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental"],
      cwd: "/new/project-a",
    },
    expected: {
      outcome: "reuse",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [
        { target: "registry", operation: "update", id: "checkout-a" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      output: {
        json: { outcome: "reuse", checkout_id: "checkout-a", rebound_from: "/old/project-a" },
      },
    },
  },
  {
    id: "identity.symlink-alias-reuses-checkout",
    title: "A symlink alias resolves the canonical checkout identity",
    area: "identity",
    given: [
      {
        kind: "workspace",
        mode: "git",
        path: "/alias/project-a",
        canonicalPath: "/work/project-a",
      },
      {
        kind: "identity-transition",
        operation: "symlink-alias",
        from: "/work/project-a",
        to: "/alias/project-a",
      },
      {
        kind: "identity-claim",
        scope: "checkout",
        id: "checkout-a",
        path: "/work/project-a",
        status: "exact",
      },
      {
        kind: "checkout",
        path: "/work/project-a",
        projectId: "project-a",
        checkoutId: "checkout-a",
      },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "running",
      },
    ],
    when: {
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "/alias/project-a",
    },
    expected: {
      outcome: "report",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [],
      runtimeEffects: [],
      output: {
        json: { outcome: "report", checkout_id: "checkout-a", canonical_path: "/work/project-a" },
      },
    },
  },
  {
    id: "identity.copied-checkout-reports-duplicate-claim",
    title: "A copied checkout reports a duplicate identity while its source exists",
    area: "identity",
    given: [
      { kind: "workspace", mode: "git", path: "/copy/project-a", copiedFrom: "/work/project-a" },
      {
        kind: "identity-transition",
        operation: "checkout-copy",
        from: "/work/project-a",
        to: "/copy/project-a",
      },
      {
        kind: "identity-claim",
        scope: "checkout",
        id: "checkout-a",
        path: "/work/project-a",
        status: "duplicate",
      },
    ],
    when: {
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "/copy/project-a",
    },
    expected: {
      outcome: "error",
      error: {
        code: "duplicate_checkout_claim",
        message: "Two live paths claim checkout-a",
        recovery: [
          "Use the original checkout at /work/project-a",
          "Recreate the copy with git clone and run supabase start --experimental",
        ],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        json: {
          outcome: "error",
          code: "duplicate_checkout_claim",
          checkout_id: "checkout-a",
          paths: ["/copy/project-a", "/work/project-a"],
          recovery: [
            "Use the original checkout at /work/project-a",
            "Recreate the copy with git clone and run supabase start --experimental",
          ],
        },
      },
    },
  },
  {
    id: "identity.fresh-clone-creates-project-and-checkout",
    title: "A fresh clone receives new project and checkout identities",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-clone-main-default"),
      { kind: "workspace", mode: "git", path: "/clone/project-a", clonedFrom: "/work/project-a" },
      {
        kind: "git-state",
        workspacePath: "/clone/project-a",
        commonDirectory: "/clone/project-a/.git",
        gitDirectory: "/clone/project-a/.git",
        head: "branch",
        branch: "main",
        commit: "clone-commit",
      },
      {
        kind: "identity-transition",
        operation: "clone",
        from: "/work/project-a",
        to: "/clone/project-a",
      },
      { kind: "identity-claim", scope: "project", id: "project-a", status: "absent" },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "/clone/project-a" },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-clone",
        checkoutId: "checkout-clone",
        contextId: "context-clone-main",
        stackId: "stack-clone-main-default",
        stackName: "default",
      },
      writes: [
        { target: "git-config", operation: "create", id: "project-clone", scope: "common" },
        { target: "git-config", operation: "create", id: "checkout-clone", scope: "worktree" },
        {
          target: "git-config",
          operation: "create",
          id: "context-clone-main",
          scope: "worktree",
          owner: "main",
        },
        { target: "registry", operation: "publish", id: "stack-clone-main-default" },
        { target: "managed-state", operation: "create", id: "stack-clone-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-clone-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-clone-main-default" }],
      details: { project_identity_storage: "git-local", git_index_mutated: false },
      output: {
        json: {
          outcome: "create",
          project_id: "project-clone",
          checkout_id: "checkout-clone",
          context_id: "context-clone-main",
          stack_id: "stack-clone-main-default",
        },
      },
    },
  },
  {
    id: "identity.missing-previous-path-rebinds-checkout",
    title: "A missing previous checkout path is rebound automatically",
    area: "identity",
    given: [
      {
        kind: "workspace",
        mode: "git",
        path: "/new/project-a",
        previousPath: "/old/project-a",
        previousPathAccess: "missing",
      },
      {
        kind: "identity-claim",
        scope: "checkout",
        id: "checkout-a",
        path: "/old/project-a",
        status: "exact",
      },
      {
        kind: "checkout",
        path: "/old/project-a",
        projectId: "project-a",
        checkoutId: "checkout-a",
      },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStack",
      input: { cwd: "/new/project-a", stackName: "default", operation: "start" },
    },
    expected: {
      outcome: "reuse",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [
        { target: "registry", operation: "update", id: "checkout-a" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      output: { api: { outcome: "reuse", checkoutId: "checkout-a", rebound: true } },
    },
  },
  {
    id: "identity.inaccessible-previous-path-fails",
    title: "An inaccessible previous path fails instead of guessing ownership",
    area: "identity",
    given: [
      {
        kind: "workspace",
        mode: "git",
        path: "/new/project-a",
        previousPath: "/mnt/project-a",
        previousPathAccess: "inaccessible",
      },
      {
        kind: "identity-claim",
        scope: "checkout",
        id: "checkout-a",
        path: "/mnt/project-a",
        status: "ambiguous",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "/new/project-a" },
    expected: {
      outcome: "error",
      error: {
        code: "checkout_path_inaccessible",
        message: "Cannot verify whether /mnt/project-a still owns checkout-a",
        recovery: [
          "Restore access to /mnt/project-a and retry",
          "Explicitly adopt checkout-a for /new/project-a",
        ],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        human: {
          summary: "Cannot safely rebind checkout-a",
          fields: { previousPath: "/mnt/project-a", currentPath: "/new/project-a" },
          recovery: [
            "Restore access to /mnt/project-a and retry",
            "Explicitly adopt checkout-a for /new/project-a",
          ],
        },
        json: {
          outcome: "error",
          code: "checkout_path_inaccessible",
          checkout_id: "checkout-a",
          recovery: [
            "Restore access to /mnt/project-a and retry",
            "Explicitly adopt checkout-a for /new/project-a",
          ],
        },
      },
    },
  },
  {
    id: "identity.concurrent-create-publishes-once",
    title: "Concurrent creation publishes one stack without aliases",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-feat-default"),
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: true },
      {
        kind: "concurrent-operation",
        operation: "create-stack",
        target: "context-feat/default",
        contenders: 2,
      },
    ],
    when: {
      interface: "managed-api",
      method: "startConcurrently",
      input: { cwd: "checkout-a", stackName: "default", contenders: 2 },
    },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-feat",
        stackId: "stack-feat-default",
        stackName: "default",
      },
      writes: [
        { target: "registry", operation: "publish", id: "stack-feat-default" },
        { target: "managed-state", operation: "create", id: "stack-feat-default" },
        { target: "runtime-state", operation: "start", id: "stack-feat-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-feat-default" }],
      details: { published_stack_count: 1, alias_count: 0, contender_results: ["create", "reuse"] },
      output: {
        api: {
          stackId: "stack-feat-default",
          publishedStackCount: 1,
          aliasCount: 0,
          contenderResults: ["create", "reuse"],
        },
      },
    },
  },
  invalidStackNameFixture("uppercase-underscore", "Feature_A"),
  invalidStackNameFixture("leading-hyphen", "-review"),
  invalidStackNameFixture("repeated-dot", "review..two"),
  {
    id: "identity.valid-stack-names-resolve-deterministically",
    title: "Default and lowercase DNS-label stack names resolve deterministically",
    area: "identity",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: true },
      { kind: "stack-names", names: ["default", "review-42"] },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStackNames",
      input: { cwd: "checkout-a", stackNames: ["default", "review-42"] },
    },
    expected: {
      outcome: "report",
      writes: [],
      runtimeEffects: [],
      details: { default: "stack-feat-default", "review-42": "stack-feat-review-42" },
      output: {
        api: {
          default: { contextId: "context-feat", stackId: "stack-feat-default" },
          "review-42": { contextId: "context-feat", stackId: "stack-feat-review-42" },
        },
      },
    },
  },
  {
    id: "identity.read-only-unregistered-checkout-does-not-write",
    title: "Read-only discovery of an unregistered checkout performs no writes",
    area: "identity",
    given: [
      { kind: "workspace", mode: "git", path: "checkout-new" },
      { kind: "identity-claim", scope: "checkout", id: "checkout-unregistered", status: "absent" },
    ],
    when: {
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "checkout-new",
    },
    expected: {
      outcome: "report",
      writes: [],
      runtimeEffects: [],
      details: { registered: false, identity_marker_created: false },
      output: { json: { outcome: "report", registered: false, stacks: [] } },
    },
  },
  {
    id: "identity.branch-copy-known-owner-creates-context-on-mutation",
    title: "A copied branch with a known owner gets a new context on first mutation",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-copy-default"),
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      {
        kind: "identity-transition",
        operation: "branch-copy",
        from: "main",
        to: "feat-copy",
        originalExists: true,
      },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: false },
      { kind: "branch", name: "feat-copy", contextId: "context-main", checkedOut: true },
      {
        kind: "identity-claim",
        scope: "context",
        id: "context-main",
        owner: "main",
        status: "exact",
      },
      { kind: "identity-claim", scope: "context", id: "context-copy", status: "absent" },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-copy",
        stackId: "stack-copy-default",
        stackName: "default",
      },
      writes: [
        {
          target: "git-config",
          operation: "create",
          id: "context-copy",
          scope: "worktree",
          owner: "feat-copy",
        },
        { target: "registry", operation: "publish", id: "stack-copy-default" },
        { target: "managed-state", operation: "create", id: "stack-copy-default" },
        { target: "runtime-state", operation: "start", id: "stack-copy-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-copy-default" }],
      details: { original_context_id: "context-main", original_owner: "main" },
      output: {
        json: {
          outcome: "create",
          branch: "feat-copy",
          context_id: "context-copy",
          original_context_id: "context-main",
          stack_id: "stack-copy-default",
        },
      },
    },
  },
  {
    id: "identity.branch-copy-read-only-does-not-write",
    title: "Read-only discovery reports a copied-branch conflict without resolving it",
    area: "identity",
    given: [
      {
        kind: "identity-transition",
        operation: "branch-copy",
        from: "main",
        to: "feat-copy",
        originalExists: true,
      },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: false },
      { kind: "branch", name: "feat-copy", contextId: "context-main", checkedOut: true },
      {
        kind: "identity-claim",
        scope: "context",
        id: "context-main",
        owner: "main",
        status: "exact",
      },
    ],
    when: {
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "report",
      warning: {
        code: "copied_branch_context_conflict",
        message: "feat-copy copied context-main from main",
        recovery: [
          "Run supabase start --experimental to create an independent context for feat-copy",
        ],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        json: {
          outcome: "report",
          code: "copied_branch_context_conflict",
          branch: "feat-copy",
          owner: "main",
          context_id: "context-main",
          recovery: [
            "Run supabase start --experimental to create an independent context for feat-copy",
          ],
        },
      },
    },
  },
  {
    id: "identity.original-gone-turns-copy-into-rename",
    title: "A copied context is preserved as a rename when its original branch is gone",
    area: "identity",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      {
        kind: "identity-transition",
        operation: "branch-copy",
        from: "main",
        to: "renamed",
        originalExists: false,
      },
      { kind: "branch", name: "renamed", contextId: "context-main", checkedOut: true },
      {
        kind: "identity-claim",
        scope: "context",
        id: "context-main",
        owner: "main",
        status: "absent",
      },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "reuse",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [
        {
          target: "git-config",
          operation: "update",
          id: "context-main",
          scope: "worktree",
          owner: "renamed",
        },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      output: {
        json: {
          outcome: "reuse",
          branch: "renamed",
          context_id: "context-main",
          rename_detected: true,
        },
      },
    },
  },
  {
    id: "identity.fresh-clone-ignores-tracked-marker",
    title: "A tracked non-Git identity marker is inert in a fresh Git clone",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-clone-main-default"),
      { kind: "workspace", mode: "git", path: "/clone/project-a", clonedFrom: "/work/project-a" },
      {
        kind: "git-state",
        workspacePath: "/clone/project-a",
        commonDirectory: "/clone/project-a/.git",
        gitDirectory: "/clone/project-a/.git",
        head: "branch",
        branch: "main",
        commit: "commit-a",
        trackedIdentityMarker: true,
      },
      { kind: "identity-claim", scope: "project", id: "project-from-marker", status: "absent" },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "/clone/project-a" },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-clone",
        checkoutId: "checkout-clone",
        contextId: "context-clone-main",
        stackId: "stack-clone-main-default",
        stackName: "default",
      },
      writes: [
        { target: "git-config", operation: "create", id: "project-clone", scope: "common" },
        { target: "git-config", operation: "create", id: "checkout-clone", scope: "worktree" },
        {
          target: "git-config",
          operation: "create",
          id: "context-clone-main",
          scope: "worktree",
          owner: "main",
        },
        { target: "registry", operation: "publish", id: "stack-clone-main-default" },
        { target: "managed-state", operation: "create", id: "stack-clone-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-clone-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-clone-main-default" }],
      details: {
        project_identity_storage: "git-local",
        tracked_marker_ignored: true,
        tracked_marker_mutated: false,
        git_index_mutated: false,
      },
      output: {
        json: {
          outcome: "create",
          project_id: "project-clone",
          checkout_id: "checkout-clone",
          context_id: "context-clone-main",
          stack_id: "stack-clone-main-default",
          tracked_marker_ignored: true,
        },
      },
    },
  },
  {
    id: "identity.folder-to-git-exact-claim-preserves-identity",
    title: "Folder-to-Git conversion preserves one exact live path claim",
    area: "identity",
    given: [
      {
        kind: "identity-transition",
        operation: "folder-to-git",
        from: "ordinary-folder",
        to: "git",
      },
      { kind: "workspace", mode: "git", path: "/work/project-a", canonicalPath: "/work/project-a" },
      {
        kind: "identity-claim",
        scope: "project",
        id: "project-a",
        path: "/work/project-a",
        status: "exact",
      },
      {
        kind: "identity-claim",
        scope: "checkout",
        id: "checkout-a",
        path: "/work/project-a",
        status: "exact",
      },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "/work/project-a" },
    expected: {
      outcome: "reuse",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [
        { target: "git-config", operation: "create", id: "project-a", scope: "common" },
        { target: "git-config", operation: "create", id: "checkout-a", scope: "worktree" },
        {
          target: "git-config",
          operation: "create",
          id: "context-main",
          scope: "worktree",
          owner: "main",
        },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { git_index_mutated: false },
      output: {
        json: {
          outcome: "reuse",
          project_id: "project-a",
          checkout_id: "checkout-a",
          converted_to_git: true,
        },
      },
    },
  },
  {
    id: "identity.folder-to-git-without-claim-creates-git-identity",
    title: "Folder-to-Git conversion without a live claim creates Git-owned identities",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-git-default"),
      {
        kind: "identity-transition",
        operation: "folder-to-git",
        from: "ordinary-folder",
        to: "git",
      },
      { kind: "workspace", mode: "git", path: "/work/project-a", canonicalPath: "/work/project-a" },
      {
        kind: "git-state",
        workspacePath: "/work/project-a",
        commonDirectory: "/work/project-a/.git",
        gitDirectory: "/work/project-a/.git",
        head: "branch",
        branch: "main",
        commit: "commit-a",
      },
      { kind: "identity-claim", scope: "project", id: "project-folder", status: "absent" },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "/work/project-a" },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-git",
        checkoutId: "checkout-git",
        contextId: "context-git-main",
        stackId: "stack-git-default",
        stackName: "default",
      },
      writes: [
        { target: "git-config", operation: "create", id: "project-git", scope: "common" },
        { target: "git-config", operation: "create", id: "checkout-git", scope: "worktree" },
        {
          target: "git-config",
          operation: "create",
          id: "context-git-main",
          scope: "worktree",
          owner: "main",
        },
        { target: "registry", operation: "publish", id: "stack-git-default" },
        { target: "managed-state", operation: "create", id: "stack-git-default" },
        { target: "runtime-state", operation: "start", id: "stack-git-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-git-default" }],
      details: { project_identity_storage: "git-local", git_index_mutated: false },
      output: {
        json: { outcome: "create", project_id: "project-git", checkout_id: "checkout-git" },
      },
    },
  },
  {
    id: "identity.folder-to-git-ambiguous-claim-fails",
    title: "Folder-to-Git conversion fails on ambiguous live identity claims",
    area: "identity",
    given: [
      {
        kind: "identity-transition",
        operation: "folder-to-git",
        from: "ordinary-folder",
        to: "git",
      },
      { kind: "workspace", mode: "git", path: "/work/project-a", canonicalPath: "/work/project-a" },
      {
        kind: "identity-claim",
        scope: "project",
        id: "project-folder",
        path: "/work/project-a",
        status: "ambiguous",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "/work/project-a" },
    expected: {
      outcome: "error",
      error: {
        code: "ambiguous_folder_to_git_identity",
        message: "Multiple live claims can preserve the folder identity",
        recovery: [
          "Inspect the claims and explicitly adopt one identity or create a fresh Git identity",
        ],
      },
      writes: [],
      runtimeEffects: [],
      details: { git_index_mutated: false },
      output: {
        json: {
          outcome: "error",
          code: "ambiguous_folder_to_git_identity",
          recovery: [
            "Inspect the claims and explicitly adopt one identity or create a fresh Git identity",
          ],
        },
      },
    },
  },
  {
    id: "identity.bare-repository-linked-worktrees-share-project",
    title: "Bare-repository worktrees share common project identity without a primary worktree",
    area: "identity",
    given: [
      ...freshManagedStartFacts("stack-b-main-default"),
      { kind: "workspace", mode: "bare-worktree", path: "worktree-a" },
      { kind: "workspace", mode: "bare-worktree", path: "worktree-b" },
      {
        kind: "git-state",
        workspacePath: "worktree-b",
        commonDirectory: "repo.git",
        gitDirectory: "repo.git/worktrees/worktree-b",
        head: "branch",
        branch: "main",
        commit: "commit-a",
      },
      { kind: "checkout", path: "worktree-a", projectId: "project-bare", checkoutId: "checkout-a" },
      { kind: "checkout", path: "worktree-b", projectId: "project-bare", checkoutId: "checkout-b" },
      { kind: "identity-claim", scope: "context", id: "context-b-main", status: "absent" },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStack",
      input: { cwd: "worktree-b", stackName: "default", operation: "start" },
    },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-bare",
        checkoutId: "checkout-b",
        contextId: "context-b-main",
        stackId: "stack-b-main-default",
        stackName: "default",
      },
      writes: [
        {
          target: "git-config",
          operation: "create",
          id: "context-b-main",
          scope: "worktree",
          owner: "main",
        },
        { target: "registry", operation: "publish", id: "stack-b-main-default" },
        { target: "managed-state", operation: "create", id: "stack-b-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-b-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-b-main-default" }],
      details: {
        project_identity_location: "repo.git",
        checkout_identity_location: "repo.git/worktrees/worktree-b",
      },
      output: {
        api: {
          projectId: "project-bare",
          checkoutId: "checkout-b",
          primaryWorktreeRequired: false,
        },
      },
    },
  },
]);

const additionalPortContractFixtures = defineManagedStackContractFixtures([
  {
    id: "ports.exact-default-value-differs-from-omitted-default",
    title: "A present default port is exact while the same omitted default is automatic",
    area: "ports",
    given: [
      { kind: "config-port", key: "api.port", intent: "exact", value: 54321, source: "local" },
      { kind: "config-port", key: "db.port", intent: "automatic", source: "omitted" },
    ],
    when: {
      interface: "managed-api",
      method: "resolvePortIntents",
      input: {
        config: { "api.port": 54321 },
        decodedDefaults: { "api.port": 54321, "db.port": 54322 },
      },
    },
    expected: {
      outcome: "report",
      writes: [],
      runtimeEffects: [],
      output: {
        api: {
          "api.port": { intent: "exact", port: 54321, source: "local" },
          "db.port": { intent: "automatic", source: "omitted" },
        },
      },
    },
  },
  {
    id: "ports.env-and-remote-values-remain-exact",
    title: "Environment-backed and selected remote ports remain exact after resolution",
    area: "ports",
    given: [
      {
        kind: "config-port",
        key: "api.port",
        intent: "exact",
        value: 55321,
        source: "environment",
      },
      { kind: "config-port", key: "db.port", intent: "exact", value: 55322, source: "remote" },
    ],
    when: {
      interface: "managed-api",
      method: "resolvePortIntents",
      input: { effectiveConfig: { "api.port": 55321, "db.port": 55322 } },
    },
    expected: {
      outcome: "report",
      writes: [],
      runtimeEffects: [],
      output: {
        api: {
          "api.port": { intent: "exact", port: 55321, source: "environment" },
          "db.port": { intent: "exact", port: 55322, source: "remote" },
        },
      },
    },
  },
  {
    id: "ports.explicit-free-port-is-used",
    title: "A free declarative port is used exactly",
    area: "ports",
    given: [
      { kind: "config-port", key: "api.port", intent: "exact", value: 54321, source: "local" },
      { kind: "managed-target", stackId: "stack-main-default", exists: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: {
        stackId: "stack-main-default",
        portIntents: { "api.port": { intent: "exact", port: 54321 } },
      },
    },
    expected: {
      outcome: "update",
      writes: [
        { target: "managed-state", operation: "update", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      output: {
        api: {
          outcome: "update",
          stackId: "stack-main-default",
          ports: { api: 54321 },
          intent: "exact",
        },
      },
    },
  },
  {
    id: "ports.new-target-allocates-and-persists-omitted-ports",
    title: "A new target allocates and persists host-wide ports for omitted keys",
    area: "ports",
    given: [
      ...freshManagedStartFacts("stack-feat-default"),
      { kind: "config-port", key: "api.port", intent: "automatic", source: "omitted" },
      { kind: "config-port", key: "db.port", intent: "automatic", source: "omitted" },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: {
        stackId: "stack-feat-default",
        portIntents: { "api.port": "automatic", "db.port": "automatic" },
      },
    },
    expected: {
      outcome: "create",
      writes: [
        { target: "managed-state", operation: "create", id: "stack-feat-default" },
        { target: "registry", operation: "publish", id: "stack-feat-default" },
        { target: "runtime-state", operation: "start", id: "stack-feat-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-feat-default" }],
      details: { host_wide: true, sticky: true },
      output: {
        api: {
          outcome: "create",
          stackId: "stack-feat-default",
          ports: { api: 55421, db: 55422 },
          intents: { api: "automatic", db: "automatic" },
        },
      },
    },
  },
  {
    id: "ports.sibling-targets-allocate-independent-ports",
    title: "A new sibling target allocates around existing host-wide port ownership",
    area: "ports",
    given: [
      ...freshManagedStartFacts("stack-feat-default"),
      { kind: "config-port", key: "api.port", intent: "automatic", source: "omitted" },
      { kind: "config-port", key: "db.port", intent: "automatic", source: "omitted" },
      {
        kind: "port-assignment",
        stackId: "stack-main-default",
        key: "api.port",
        port: 55421,
        intent: "automatic",
      },
      {
        kind: "port-assignment",
        stackId: "stack-main-review",
        key: "db.port",
        port: 55422,
        intent: "automatic",
      },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: {
        stackId: "stack-feat-default",
        portIntents: { "api.port": "automatic", "db.port": "automatic" },
      },
    },
    expected: {
      outcome: "create",
      writes: [
        { target: "managed-state", operation: "create", id: "stack-feat-default" },
        { target: "registry", operation: "publish", id: "stack-feat-default" },
        { target: "runtime-state", operation: "start", id: "stack-feat-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-feat-default" }],
      details: {
        host_wide: true,
        sticky: true,
        avoided_sibling_stack_ids: ["stack-main-default", "stack-main-review"],
      },
      output: {
        api: {
          outcome: "create",
          stackId: "stack-feat-default",
          ports: { api: 55423, db: 55424 },
          intents: { api: "automatic", db: "automatic" },
        },
      },
    },
  },
  {
    id: "ports.sticky-ports-reuse-on-return",
    title: "Returning to an existing target reuses its sticky automatic ports",
    area: "ports",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-feat-default",
        contextId: "context-feat",
        lifecycle: "stopped",
      },
      { kind: "config-port", key: "api.port", intent: "automatic", source: "omitted" },
      {
        kind: "port-assignment",
        stackId: "stack-feat-default",
        key: "api.port",
        port: 55421,
        intent: "automatic",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "reuse",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-feat",
        stackId: "stack-feat-default",
        stackName: "default",
      },
      writes: [{ target: "runtime-state", operation: "start", id: "stack-feat-default" }],
      runtimeEffects: [{ operation: "start", stackId: "stack-feat-default" }],
      output: {
        human: { summary: "Started feat-a/default", fields: { apiUrl: "http://127.0.0.1:55421" } },
        json: {
          outcome: "reuse",
          stack_id: "stack-feat-default",
          ports: { api: 55421 },
          sticky: true,
        },
      },
    },
  },
  {
    id: "ports.later-sticky-port-collision-fails",
    title: "A later collision on a sticky automatic port fails without relocation",
    area: "ports",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-feat-default",
        contextId: "context-feat",
        lifecycle: "stopped",
      },
      {
        kind: "port-assignment",
        stackId: "stack-feat-default",
        key: "api.port",
        port: 55421,
        intent: "automatic",
      },
      { kind: "occupied-port", port: 55421, owner: "external-process" },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "error",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-feat",
        stackId: "stack-feat-default",
        stackName: "default",
      },
      error: {
        code: "sticky_port_occupied",
        message: "stack-feat-default owns sticky api.port 55421, but it is in use",
        recovery: [
          "Stop the process using port 55421",
          "Delete and recreate the stack to allocate new automatic ports",
        ],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        json: {
          outcome: "error",
          code: "sticky_port_occupied",
          stack_id: "stack-feat-default",
          port: 55421,
          config_key: "api.port",
          relocated: false,
          recovery: [
            "Stop the process using port 55421",
            "Delete and recreate the stack to allocate new automatic ports",
          ],
        },
      },
    },
  },
  {
    id: "ports.config-change-on-stopped-stack-applies",
    title: "Changing an exact port on a stopped stack applies on next start",
    area: "ports",
    given: [
      ...mainCheckoutContextFacts,
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
      {
        kind: "config-port",
        key: "api.port",
        intent: "exact",
        value: 55321,
        previousValue: 54321,
        source: "local",
      },
      {
        kind: "port-assignment",
        stackId: "stack-main-default",
        key: "api.port",
        port: 54321,
        intent: "exact",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "update",
      selection: mainDefaultSelection,
      writes: [
        { target: "managed-state", operation: "update", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      output: {
        human: { summary: "Started main/default", fields: { apiUrl: "http://127.0.0.1:55321" } },
        json: {
          outcome: "update",
          stack_id: "stack-main-default",
          previous_port: 54321,
          port: 55321,
        },
      },
    },
  },
  {
    id: "ports.config-change-on-running-stack-reports-drift",
    title: "Changing an exact port on a running stack reports drift",
    area: "ports",
    given: [
      ...mainCheckoutContextFacts,
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "running",
      },
      {
        kind: "config-port",
        key: "api.port",
        intent: "exact",
        value: 55321,
        previousValue: 54321,
        source: "local",
      },
      {
        kind: "port-assignment",
        stackId: "stack-main-default",
        key: "api.port",
        port: 54321,
        intent: "exact",
      },
    ],
    when: {
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "report",
      selection: mainDefaultSelection,
      warning: {
        code: "running_stack_config_drift",
        message: "api.port is running on 54321 but config requires 55321",
        recovery: ["Run supabase stop --experimental, then supabase start --experimental"],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        human: {
          summary: "main/default is running with unapplied port configuration",
          fields: {
            stackId: "stack-main-default",
            configKey: "api.port",
            runningPort: "54321",
            configuredPort: "55321",
            drift: "true",
          },
          recovery: ["Run supabase stop --experimental, then supabase start --experimental"],
        },
        json: {
          outcome: "report",
          code: "running_stack_config_drift",
          stack_id: "stack-main-default",
          config_key: "api.port",
          running_port: 54321,
          requested_port: 55321,
          drift: true,
          recovery: ["Run supabase stop --experimental, then supabase start --experimental"],
        },
      },
    },
  },
  {
    id: "ports.removing-exact-key-keeps-current-port-sticky",
    title: "Removing an exact key keeps the current port as sticky automatic state",
    area: "ports",
    given: [
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
      {
        kind: "config-port",
        key: "api.port",
        intent: "automatic",
        previousValue: 54321,
        source: "omitted",
      },
      {
        kind: "port-assignment",
        stackId: "stack-main-default",
        key: "api.port",
        port: 54321,
        intent: "exact",
      },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: { stackId: "stack-main-default", portIntents: { "api.port": "automatic" } },
    },
    expected: {
      outcome: "update",
      writes: [
        { target: "managed-state", operation: "update", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { sibling_allocation_independent: true },
      output: {
        api: {
          stackId: "stack-main-default",
          ports: { api: 54321 },
          intents: { api: "automatic" },
          sticky: true,
        },
      },
    },
  },
  {
    id: "ports.running-legacy-source-fails-before-allocation",
    title: "A running legacy source fails before bootstrap or port allocation",
    area: "ports",
    given: [
      {
        kind: "legacy-state",
        lifecycle: "running",
        database: "compatible",
        storage: "compatible",
        credentials: "compatible",
      },
      { kind: "occupied-port", port: 54321, owner: "legacy-stack", ownerId: "legacy-project-a" },
      { kind: "config-port", key: "api.port", intent: "exact", value: 54321, source: "local" },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "error",
      error: {
        code: "legacy_source_running",
        message: "The matching legacy stack is still running on api.port 54321",
        recovery: ["Stop the legacy stack, then retry supabase start --experimental"],
      },
      writes: [],
      runtimeEffects: [],
      details: { allocation_attempted: false, legacy_source_stopped: false },
      output: {
        json: {
          outcome: "error",
          code: "legacy_source_running",
          port: 54321,
          config_key: "api.port",
          allocation_attempted: false,
          recovery: ["Stop the legacy stack, then retry supabase start --experimental"],
        },
      },
    },
  },
]);

const nativeServiceNames = managedNativeServiceMatrix.services.map(([service]) => service);

const additionalRuntimeContractFixtures = defineManagedStackContractFixtures([
  {
    id: "runtime.explicit-api-overrides-auto",
    title: "An explicit managed-API runtime overrides the default automatic selection",
    area: "runtime",
    given: [
      ...freshMainManagedStartFacts,
      { kind: "runtime-request", source: "managed-api", runtime: "native" },
      { kind: "runtime-request", source: "default", runtime: "auto" },
      { kind: "runtime-availability", runtime: "native", available: true },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: { stackId: "stack-main-default", runtime: "native" },
    },
    expected: {
      outcome: "create",
      writes: [
        { target: "managed-state", operation: "create", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { resolved_runtime: "native", source: "managed-api", stack_wide: true },
      output: {
        api: { stackId: "stack-main-default", runtime: "native", runtimeSource: "managed-api" },
      },
    },
  },
  {
    id: "runtime.config-overrides-default-auto",
    title: "A config runtime overrides automatic selection when no explicit override exists",
    area: "runtime",
    given: [
      ...mainCheckoutContextFacts,
      ...freshMainManagedStartFacts,
      { kind: "runtime-request", source: "config", runtime: "native" },
      { kind: "runtime-request", source: "default", runtime: "auto" },
      { kind: "runtime-availability", runtime: "native", available: true },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
      selection: mainDefaultSelection,
      writes: [
        { target: "managed-state", operation: "create", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { resolved_runtime: "native", source: "config" },
      output: {
        human: {
          summary: "Started main/default with native runtime",
          fields: { runtime: "native" },
        },
        json: {
          outcome: "create",
          stack_id: "stack-main-default",
          runtime: "native",
          runtime_source: "config",
        },
      },
    },
  },
  {
    id: "runtime.explicit-and-config-conflict-fails",
    title: "Conflicting explicit and config runtimes fail before services start",
    area: "runtime",
    given: [
      { kind: "runtime-request", source: "cli", runtime: "docker" },
      { kind: "runtime-request", source: "config", runtime: "native" },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental", "--runtime", "docker"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "error",
      error: {
        code: "runtime_selection_conflict",
        message: "CLI requests docker while config.toml requests native",
        recovery: ["Remove one runtime override", "Make the CLI and config runtime values agree"],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        json: {
          outcome: "error",
          code: "runtime_selection_conflict",
          cli_runtime: "docker",
          config_runtime: "native",
          recovery: ["Remove one runtime override", "Make the CLI and config runtime values agree"],
        },
      },
    },
  },
  {
    id: "runtime.auto-prefers-docker",
    title: "Automatic selection prefers usable Docker",
    area: "runtime",
    given: [
      ...freshMainManagedStartFacts,
      { kind: "runtime-request", source: "default", runtime: "auto" },
      { kind: "runtime-availability", runtime: "docker", available: true },
      { kind: "runtime-availability", runtime: "native", available: true },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: { stackId: "stack-main-default", runtime: "auto" },
    },
    expected: {
      outcome: "create",
      writes: [
        { target: "managed-state", operation: "create", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { resolved_runtime: "docker", persisted: true },
      output: { api: { stackId: "stack-main-default", runtime: "docker", runtimeSource: "auto" } },
    },
  },
  {
    id: "runtime.auto-selects-fully-qualified-native",
    title:
      "Automatic selection uses native only when Docker is unusable and the full graph qualifies",
    area: "runtime",
    given: [
      ...freshMainManagedStartFacts,
      { kind: "runtime-request", source: "default", runtime: "auto" },
      {
        kind: "runtime-availability",
        runtime: "docker",
        available: false,
        reason: "daemon unavailable",
      },
      { kind: "runtime-availability", runtime: "native", available: true },
      {
        kind: "native-qualification",
        platform: "darwin-arm64",
        qualifiedServices: nativeServiceNames,
        failedServices: [],
      },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: { stackId: "stack-main-default", runtime: "auto" },
    },
    expected: {
      outcome: "create",
      writes: [
        { target: "managed-state", operation: "create", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { resolved_runtime: "native", qualified_service_count: 13, mixed_runtime: false },
      output: {
        api: { stackId: "stack-main-default", runtime: "native", qualifiedServiceCount: 13 },
      },
    },
  },
  {
    id: "runtime.auto-fails-when-neither-runtime-is-available",
    title: "Automatic selection reports both availability failures",
    area: "runtime",
    given: [
      { kind: "runtime-request", source: "default", runtime: "auto" },
      {
        kind: "runtime-availability",
        runtime: "docker",
        available: false,
        reason: "daemon unavailable",
      },
      {
        kind: "runtime-availability",
        runtime: "native",
        available: false,
        reason: "platform graph not qualified",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "error",
      error: {
        code: "no_runtime_available",
        message: "Neither Docker nor native can run this stack",
        recovery: [
          "Start or install Docker",
          "Use a platform with a fully qualified native service graph",
        ],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        human: {
          summary: "No runtime is available",
          fields: { docker: "daemon unavailable", native: "platform graph not qualified" },
          recovery: [
            "Start or install Docker",
            "Use a platform with a fully qualified native service graph",
          ],
        },
        json: {
          outcome: "error",
          code: "no_runtime_available",
          docker_reason: "daemon unavailable",
          native_reason: "platform graph not qualified",
          recovery: [
            "Start or install Docker",
            "Use a platform with a fully qualified native service graph",
          ],
        },
      },
    },
  },
  {
    id: "runtime.explicit-runtime-is-strict",
    title: "An explicit runtime fails strictly when its prerequisite is missing",
    area: "runtime",
    given: [
      { kind: "runtime-request", source: "cli", runtime: "docker" },
      {
        kind: "runtime-availability",
        runtime: "docker",
        available: false,
        reason: "daemon unavailable",
      },
      { kind: "runtime-availability", runtime: "native", available: true },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental", "--runtime", "docker"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "error",
      error: {
        code: "docker_unavailable",
        message: "Docker was explicitly requested but its daemon is unavailable",
        recovery: ["Start Docker", "Remove --runtime docker to use automatic selection"],
      },
      writes: [],
      runtimeEffects: [],
      details: { fallback_attempted: false },
      output: {
        json: {
          outcome: "error",
          code: "docker_unavailable",
          requested_runtime: "docker",
          reason: "daemon unavailable",
          fallback_attempted: false,
          recovery: ["Start Docker", "Remove --runtime docker to use automatic selection"],
        },
      },
    },
  },
  {
    id: "runtime.persisted-runtime-reused-for-auto",
    title: "An existing stack reuses its persisted runtime for omitted or automatic selection",
    area: "runtime",
    given: [
      ...mainCheckoutContextFacts,
      { kind: "persisted-runtime", stackId: "stack-main-default", runtime: "native" },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
      { kind: "runtime-request", source: "default", runtime: "auto" },
      { kind: "runtime-availability", runtime: "docker", available: true },
      { kind: "runtime-availability", runtime: "native", available: true },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "reuse",
      selection: mainDefaultSelection,
      writes: [{ target: "runtime-state", operation: "start", id: "stack-main-default" }],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { runtime: "native", auto_re_evaluated: false },
      output: {
        json: {
          outcome: "reuse",
          stack_id: "stack-main-default",
          runtime: "native",
          persisted: true,
        },
      },
    },
  },
  {
    id: "runtime.missing-persisted-prerequisite-fails",
    title: "A missing prerequisite for the persisted runtime fails without switching",
    area: "runtime",
    given: [
      ...mainCheckoutContextFacts,
      { kind: "persisted-runtime", stackId: "stack-main-default", runtime: "native" },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
      { kind: "runtime-request", source: "default", runtime: "auto" },
      {
        kind: "runtime-availability",
        runtime: "native",
        available: false,
        reason: "artifact missing",
      },
      { kind: "runtime-availability", runtime: "docker", available: true },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "error",
      selection: mainDefaultSelection,
      error: {
        code: "persisted_runtime_unavailable",
        message: "stack-main-default uses native, but a required artifact is missing",
        recovery: [
          "Restore the native prerequisite",
          "Create a new Docker named stack",
          "Delete and recreate this stack",
        ],
      },
      writes: [],
      runtimeEffects: [],
      details: { switched_to_docker: false },
      output: {
        json: {
          outcome: "error",
          code: "persisted_runtime_unavailable",
          stack_id: "stack-main-default",
          runtime: "native",
          reason: "artifact missing",
          recovery: [
            "Restore the native prerequisite",
            "Create a new Docker named stack",
            "Delete and recreate this stack",
          ],
        },
      },
    },
  },
  {
    id: "runtime.status-reports-one-stack-wide-runtime",
    title: "Status reports one persisted stack-wide runtime and any drift",
    area: "runtime",
    given: [
      ...mainCheckoutContextFacts,
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "running",
      },
      { kind: "persisted-runtime", stackId: "stack-main-default", runtime: "docker" },
      { kind: "runtime-request", source: "config", runtime: "native" },
    ],
    when: {
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "report",
      selection: mainDefaultSelection,
      warning: {
        code: "running_stack_runtime_drift",
        message: "stack-main-default runs with docker but config requests native",
        recovery: [
          "Keep using Docker by restoring runtime = docker",
          "Create a new native named stack",
          "Delete and recreate stack-main-default with native",
        ],
      },
      writes: [],
      runtimeEffects: [],
      details: { mixed_runtime: false },
      output: {
        human: {
          summary: "main/default is running with Docker",
          fields: { runtime: "docker", configuredRuntime: "native", drift: "true" },
          recovery: [
            "Keep using Docker by restoring runtime = docker",
            "Create a new native named stack",
            "Delete and recreate stack-main-default with native",
          ],
        },
        json: {
          outcome: "report",
          code: "running_stack_runtime_drift",
          stack_id: "stack-main-default",
          runtime: "docker",
          configured_runtime: "native",
          drift: true,
          services: { runtime: "docker" },
          recovery: [
            "Keep using Docker by restoring runtime = docker",
            "Create a new native named stack",
            "Delete and recreate stack-main-default with native",
          ],
        },
      },
    },
  },
  {
    id: "native-qualification.all-services-qualify-platform",
    title: "A platform is native-supported only when all 13 services qualify",
    area: "native-qualification",
    given: [
      {
        kind: "native-qualification",
        platform: "darwin-arm64",
        qualifiedServices: nativeServiceNames,
        failedServices: [],
      },
    ],
    when: {
      interface: "managed-api",
      method: "preflightNative",
      input: { platform: "darwin-arm64" },
    },
    expected: {
      outcome: "report",
      writes: [],
      runtimeEffects: [],
      details: { qualified: true, qualified_service_count: 13, failed_service_count: 0 },
      output: { api: { platform: "darwin-arm64", qualified: true, services: nativeServiceNames } },
    },
  },
  {
    id: "native-qualification.one-service-failure-disables-platform",
    title: "One failed service disables native mode for the whole platform",
    area: "native-qualification",
    given: [
      {
        kind: "native-qualification",
        platform: "linux-amd64",
        qualifiedServices: nativeServiceNames.filter((service) => service !== "imgproxy"),
        failedServices: ["imgproxy"],
      },
    ],
    when: {
      interface: "managed-api",
      method: "preflightNative",
      input: { platform: "linux-amd64" },
    },
    expected: {
      outcome: "error",
      error: {
        code: "native_platform_not_qualified",
        message: "linux-amd64 is missing qualification for imgproxy",
        recovery: ["Use Docker", "Complete imgproxy qualification for linux-amd64"],
      },
      writes: [],
      runtimeEffects: [],
      details: {
        qualified: false,
        qualified_service_count: 12,
        failed_service_count: 1,
        reduced_graph: false,
        docker_fallback_per_service: false,
      },
      output: {
        api: {
          platform: "linux-amd64",
          qualified: false,
          failedServices: ["imgproxy"],
          availableServices: [],
        },
      },
    },
  },
  {
    id: "native-qualification.unsupported-platform-fails-preflight",
    title: "An unsupported native platform fails deterministic preflight",
    area: "native-qualification",
    given: [
      { kind: "runtime-request", source: "cli", runtime: "native" },
      {
        kind: "native-qualification",
        platform: "darwin-x64",
        qualifiedServices: [],
        failedServices: nativeServiceNames,
      },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental", "--runtime", "native"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "error",
      error: {
        code: "native_platform_unsupported",
        message: "Native mode is not qualified on darwin-x64",
        recovery: ["Use Docker", "Use darwin-arm64, linux-amd64, or linux-arm64"],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        json: {
          outcome: "error",
          code: "native_platform_unsupported",
          platform: "darwin-x64",
          supported_platforms: ["darwin-arm64", "linux-amd64", "linux-arm64"],
          recovery: ["Use Docker", "Use darwin-arm64, linux-amd64, or linux-arm64"],
        },
      },
    },
  },
]);

const selectorConflictFixture = (
  id: string,
  title: string,
  selectors: ReadonlyArray<string>,
  selectorSummary: string,
): ManagedStackContractScenario => ({
  id,
  title,
  area: "reclamation",
  given: [{ kind: "managed-record", stackId: "stack-main-default", status: "active" }],
  when: {
    interface: "cli",
    argv: ["stop", "--experimental", ...selectors],
    cwd: "checkout-a",
  },
  expected: {
    outcome: "error",
    error: {
      code: "mutually_exclusive_stack_selectors",
      message: "Choose exactly one of contextual, --stack, --stack-id, or --all selection",
      recovery: ["Remove all but one stack selector"],
    },
    writes: [],
    runtimeEffects: [],
    output: {
      human: {
        summary: "Stack selectors cannot be combined",
        fields: { selectors: selectorSummary },
        recovery: ["Remove all but one stack selector"],
      },
      json: {
        outcome: "error",
        code: "mutually_exclusive_stack_selectors",
        recovery: ["Remove all but one stack selector"],
      },
    },
  },
});

const additionalLifecycleContractFixtures = defineManagedStackContractFixtures([
  {
    id: "bootstrap.existing-managed-target-ignores-legacy",
    title: "An existing managed target starts without reading legacy state",
    area: "bootstrap",
    given: [
      { kind: "managed-target", stackId: "stack-main-default", exists: true },
      {
        kind: "legacy-state",
        lifecycle: "running",
        database: "compatible",
        storage: "compatible",
        credentials: "compatible",
      },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: { stackId: "stack-main-default" },
    },
    expected: {
      outcome: "reuse",
      writes: [{ target: "runtime-state", operation: "start", id: "stack-main-default" }],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { legacy_state_read: false, legacy_state_mutated: false },
      output: {
        api: { stackId: "stack-main-default", bootstrap: "not-attempted", legacyStateRead: false },
      },
    },
  },
  {
    id: "bootstrap.incompatible-legacy-starts-fresh",
    title: "A first start with incompatible stopped legacy state creates a fresh managed target",
    area: "bootstrap",
    given: [
      ...mainCheckoutContextFacts,
      { kind: "managed-target", stackId: "stack-main-default", exists: false },
      {
        kind: "legacy-state",
        lifecycle: "stopped",
        database: "incompatible",
        storage: "absent",
        credentials: "absent",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
      selection: mainDefaultSelection,
      writes: [
        { target: "managed-state", operation: "create", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: {
        bootstrap: "fresh",
        legacy_state: "incompatible",
        legacy_state_mutated: false,
      },
      output: {
        human: { summary: "Created a fresh main/default stack", fields: { bootstrap: "fresh" } },
        json: {
          outcome: "create",
          stack_id: "stack-main-default",
          bootstrap: "fresh",
          legacy_state_mutated: false,
        },
      },
    },
  },
  {
    id: "bootstrap.absent-legacy-starts-fresh",
    title: "A first start without legacy state creates a fresh managed target",
    area: "bootstrap",
    given: [
      ...mainCheckoutContextFacts,
      { kind: "managed-target", stackId: "stack-main-default", exists: false },
      {
        kind: "legacy-state",
        lifecycle: "absent",
        database: "absent",
        storage: "absent",
        credentials: "absent",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
      selection: mainDefaultSelection,
      writes: [
        { target: "managed-state", operation: "create", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { bootstrap: "fresh", legacy_state: "absent", legacy_state_mutated: false },
      output: {
        human: { summary: "Created a fresh main/default stack", fields: { bootstrap: "fresh" } },
        json: {
          outcome: "create",
          stack_id: "stack-main-default",
          bootstrap: "fresh",
          legacy_state_mutated: false,
        },
      },
    },
  },
  {
    id: "bootstrap.running-legacy-source-fails-without-mutation",
    title: "A running legacy source fails without stopping, copying, or publishing",
    area: "bootstrap",
    given: [
      { kind: "managed-target", stackId: "stack-main-default", exists: false },
      {
        kind: "legacy-state",
        lifecycle: "running",
        database: "compatible",
        storage: "compatible",
        credentials: "compatible",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "error",
      error: {
        code: "legacy_source_running",
        message: "The legacy stack must be stopped before it can be copied",
        recovery: ["Stop the legacy stack", "Retry supabase start --experimental"],
      },
      writes: [],
      runtimeEffects: [],
      details: {
        legacy_source_stopped: false,
        managed_target_published: false,
        partial_state: false,
      },
      output: {
        json: {
          outcome: "error",
          code: "legacy_source_running",
          legacy_source_stopped: false,
          managed_target_published: false,
          recovery: ["Stop the legacy stack", "Retry supabase start --experimental"],
        },
      },
    },
  },
  {
    id: "bootstrap.failed-copy-rolls-back",
    title: "A failed bootstrap removes partial managed state before publication",
    area: "bootstrap",
    given: [
      { kind: "managed-target", stackId: "stack-main-default", exists: false },
      {
        kind: "legacy-state",
        lifecycle: "stopped",
        database: "compatible",
        storage: "compatible",
        credentials: "compatible",
      },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: { stackId: "stack-main-default", injectCopyFailure: true },
    },
    expected: {
      outcome: "error",
      error: {
        code: "legacy_bootstrap_failed",
        message: "Copying compatible legacy state failed before publication",
        recovery: ["Retry the same start command after correcting the copy failure"],
      },
      writes: [{ target: "managed-state", operation: "delete", id: "stack-main-default" }],
      runtimeEffects: [{ operation: "delete", stackId: "stack-main-default" }],
      details: {
        active_target_exists: false,
        registry_record_published: false,
        legacy_state_mutated: false,
      },
      output: {
        api: {
          outcome: "error",
          code: "legacy_bootstrap_failed",
          activeTargetExists: false,
          registryRecordPublished: false,
          retryable: true,
        },
      },
    },
  },
  {
    id: "bootstrap.retry-after-failed-copy-succeeds",
    title: "The same start succeeds after a failed bootstrap was rolled back",
    area: "bootstrap",
    given: [
      {
        kind: "operation-result",
        operation: "legacy-bootstrap",
        stackId: "stack-main-default",
        outcome: "rolled-back",
      },
      { kind: "managed-target", stackId: "stack-main-default", exists: false },
      {
        kind: "legacy-state",
        lifecycle: "stopped",
        database: "compatible",
        storage: "compatible",
        credentials: "compatible",
      },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: { stackId: "stack-main-default" },
    },
    expected: {
      outcome: "create",
      writes: [
        { target: "managed-state", operation: "copy", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [
        { operation: "copy", stackId: "stack-main-default" },
        { operation: "start", stackId: "stack-main-default" },
      ],
      details: {
        retry_after_rollback: true,
        same_start_request: true,
        legacy_state_mutated: false,
      },
      output: {
        api: {
          outcome: "create",
          stackId: "stack-main-default",
          bootstrap: "copied",
        },
      },
    },
  },
  {
    id: "bootstrap.managed-and-legacy-diverge-after-copy",
    title: "Managed starts never reread legacy state after a successful bootstrap",
    area: "bootstrap",
    given: [
      ...mainCheckoutContextFacts,
      { kind: "managed-target", stackId: "stack-main-default", exists: true },
      {
        kind: "legacy-state",
        lifecycle: "stopped",
        database: "compatible",
        storage: "incompatible",
        credentials: "incompatible",
      },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "reuse",
      selection: mainDefaultSelection,
      writes: [{ target: "runtime-state", operation: "start", id: "stack-main-default" }],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { legacy_state_read: false, legacy_state_mutated: false, timelines_diverged: true },
      output: {
        json: {
          outcome: "reuse",
          stack_id: "stack-main-default",
          bootstrap: "not-attempted",
          timelines_diverged: true,
        },
      },
    },
  },
  {
    id: "credentials.configured-values-are-authoritative",
    title: "Configured auth values are authoritative and persist globally only by reference",
    area: "credentials",
    given: [
      ...freshMainManagedStartFacts,
      { kind: "credential-state", source: "configured", valuesId: "configured-auth-v1" },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: { stackId: "stack-main-default", auth: "configured-auth-v1" },
    },
    expected: {
      outcome: "create",
      writes: [
        { target: "managed-state", operation: "create", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: {
        credential_values_id: "configured-auth-v1",
        source: "configured",
        global_credentials_reference: "configured-auth-v1",
        plaintext_secrets_in_global_state: false,
      },
      output: {
        api: {
          stackId: "stack-main-default",
          credentialsSource: "configured",
          credentialsValuesId: "configured-auth-v1",
        },
      },
    },
  },
  {
    id: "credentials.omitted-values-use-stable-defaults",
    title: "Omitted auth values use stable local defaults",
    area: "credentials",
    given: [
      ...mainCheckoutContextFacts,
      ...freshMainManagedStartFacts,
      { kind: "credential-state", source: "local-default", valuesId: "stable-local-defaults-v1" },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
      selection: mainDefaultSelection,
      writes: [
        { target: "managed-state", operation: "create", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: {
        credential_values_id: "stable-local-defaults-v1",
        generated_per_start: false,
        plaintext_secrets_in_global_state: false,
      },
      output: {
        json: {
          outcome: "create",
          stack_id: "stack-main-default",
          credentials_source: "local-default",
          credentials_stable: true,
        },
      },
    },
  },
  {
    id: "credentials.unchanged-values-survive-restart",
    title: "Unchanged credential values remain valid across restart",
    area: "credentials",
    given: [
      ...mainCheckoutContextFacts,
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
      { kind: "credential-state", source: "persisted", valuesId: "stable-local-defaults-v1" },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "reuse",
      selection: mainDefaultSelection,
      writes: [{ target: "runtime-state", operation: "start", id: "stack-main-default" }],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { credential_values_id: "stable-local-defaults-v1", credentials_rotated: false },
      output: {
        json: { outcome: "reuse", stack_id: "stack-main-default", credentials_unchanged: true },
      },
    },
  },
  {
    id: "credentials.explicit-change-applies-after-stop",
    title: "An explicit auth change applies to a stopped stack on next start",
    area: "credentials",
    given: [
      ...mainCheckoutContextFacts,
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
      {
        kind: "credential-state",
        source: "configured",
        valuesId: "configured-auth-v2",
        previousValuesId: "configured-auth-v1",
      },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "update",
      selection: mainDefaultSelection,
      writes: [
        { target: "managed-state", operation: "update", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { plaintext_secrets_in_global_state: false },
      output: {
        json: {
          outcome: "update",
          stack_id: "stack-main-default",
          previous_credentials_values_id: "configured-auth-v1",
          credentials_values_id: "configured-auth-v2",
        },
      },
    },
  },
  {
    id: "credentials.running-change-reports-drift",
    title: "An auth change on a running stack reports unapplied drift",
    area: "credentials",
    given: [
      ...mainCheckoutContextFacts,
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "running",
      },
      {
        kind: "credential-state",
        source: "configured",
        valuesId: "configured-auth-v2",
        previousValuesId: "configured-auth-v1",
      },
    ],
    when: {
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "report",
      selection: mainDefaultSelection,
      warning: {
        code: "running_stack_credentials_drift",
        message: "Configured auth values differ from the running stack",
        recovery: ["Run supabase stop --experimental, then supabase start --experimental"],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        human: {
          summary: "main/default is running with unapplied auth configuration",
          fields: { stackId: "stack-main-default", drift: "true" },
          recovery: ["Run supabase stop --experimental, then supabase start --experimental"],
        },
        json: {
          outcome: "report",
          code: "running_stack_credentials_drift",
          stack_id: "stack-main-default",
          drift: true,
          recovery: ["Run supabase stop --experimental, then supabase start --experimental"],
        },
      },
    },
  },
  {
    id: "credentials.compatible-legacy-auth-is-retained",
    title: "Compatible legacy auth configuration is retained during bootstrap",
    area: "credentials",
    given: [
      { kind: "managed-target", stackId: "stack-main-default", exists: false },
      {
        kind: "legacy-state",
        lifecycle: "stopped",
        database: "compatible",
        storage: "compatible",
        credentials: "compatible",
      },
      { kind: "credential-state", source: "legacy", valuesId: "legacy-auth-v1" },
    ],
    when: {
      interface: "managed-api",
      method: "startStack",
      input: { stackId: "stack-main-default" },
    },
    expected: {
      outcome: "create",
      writes: [
        { target: "managed-state", operation: "copy", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [
        { operation: "copy", stackId: "stack-main-default" },
        { operation: "start", stackId: "stack-main-default" },
      ],
      details: {
        credential_values_id: "legacy-auth-v1",
        legacy_state_mutated: false,
        plaintext_secrets_in_global_state: false,
      },
      output: {
        api: {
          stackId: "stack-main-default",
          bootstrap: "copied",
          credentialsValuesId: "legacy-auth-v1",
        },
      },
    },
  },
  {
    id: "reclamation.default-stop-preserves-data",
    title: "Default experimental stop preserves managed data",
    area: "reclamation",
    given: [
      ...mainCheckoutContextFacts,
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "running",
      },
    ],
    when: { interface: "cli", argv: ["stop", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "update",
      selection: mainDefaultSelection,
      writes: [{ target: "runtime-state", operation: "update", id: "stack-main-default" }],
      runtimeEffects: [{ operation: "stop", stackId: "stack-main-default" }],
      details: { data_preserved: true, registry_record_preserved: true },
      output: {
        human: { summary: "Stopped main/default", fields: { dataPreserved: "true" } },
        json: { outcome: "update", stack_id: "stack-main-default", data_preserved: true },
      },
    },
  },
  {
    id: "reclamation.delete-repeat-is-idempotent",
    title: "Repeating global deletion of a tombstoned stack is a successful no-op",
    area: "reclamation",
    given: [{ kind: "managed-record", stackId: "stack-orphan", status: "tombstoned" }],
    when: {
      interface: "cli",
      argv: ["stop", "--experimental", "--stack-id", "stack-orphan", "--no-backup"],
      cwd: "outside-any-checkout",
    },
    expected: {
      outcome: "no-op",
      writes: [],
      runtimeEffects: [],
      details: { tombstoned: true, idempotent: true },
      output: {
        json: {
          outcome: "no-op",
          stack_id: "stack-orphan",
          tombstoned: true,
          already_deleted: true,
        },
      },
    },
  },
  {
    id: "reclamation.branch-delete-does-not-delete-data",
    title: "Deleting a Git branch alone never deletes its mutable stack data",
    area: "reclamation",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
      { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: false },
      {
        kind: "git-state",
        workspacePath: "checkout-a",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git",
        head: "branch",
        branch: "main",
        commit: "commit-main",
      },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-feat-default",
        contextId: "context-feat",
        lifecycle: "stopped",
      },
    ],
    when: { interface: "git", argv: ["branch", "-D", "feat-a"], cwd: "checkout-a" },
    expected: {
      outcome: "no-op",
      writes: [],
      runtimeEffects: [],
      details: {
        stack_data_preserved: true,
        stack_orphaned: true,
        orphaned_stack_id: "stack-feat-default",
      },
      output: { human: { summary: "Deleted branch feat-a", fields: {} } },
    },
  },
  {
    id: "reclamation.prune-removes-metadata-only",
    title: "Prune removes orphan metadata without deleting mutable stack data",
    area: "reclamation",
    given: [
      { kind: "managed-record", stackId: "stack-orphan", status: "orphaned" },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-orphan",
        contextId: "context-orphan",
        lifecycle: "stopped",
        orphaned: true,
      },
    ],
    when: { interface: "cli", argv: ["stack", "prune", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "update",
      writes: [{ target: "registry", operation: "delete", id: "stack-orphan" }],
      runtimeEffects: [],
      details: { metadata_removed: true, mutable_data_deleted: false },
      output: {
        human: { summary: "Pruned 1 orphaned metadata record", fields: { dataDeleted: "false" } },
        json: { outcome: "update", pruned_records: ["stack-orphan"], mutable_data_deleted: false },
      },
    },
  },
  selectorConflictFixture(
    "reclamation.selectors-stack-and-stack-id-conflict",
    "Named and global-ID stack selectors cannot be combined",
    ["--stack", "review", "--stack-id", "stack-main-default"],
    "--stack, --stack-id",
  ),
  selectorConflictFixture(
    "reclamation.selectors-stack-and-all-conflict",
    "Named and all-stack selectors cannot be combined",
    ["--stack", "review", "--all"],
    "--stack, --all",
  ),
  selectorConflictFixture(
    "reclamation.selectors-stack-id-and-all-conflict",
    "Global-ID and all-stack selectors cannot be combined",
    ["--stack-id", "stack-main-default", "--all"],
    "--stack-id, --all",
  ),
  {
    id: "reclamation.stop-is-engine-scoped",
    title: "Experimental stop affects the selected managed stack and never the legacy engine",
    area: "reclamation",
    given: [
      ...mainCheckoutContextFacts,
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "running",
      },
      {
        kind: "legacy-state",
        lifecycle: "running",
        database: "compatible",
        storage: "compatible",
        credentials: "compatible",
      },
    ],
    when: { interface: "cli", argv: ["stop", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "update",
      selection: mainDefaultSelection,
      writes: [{ target: "runtime-state", operation: "update", id: "stack-main-default" }],
      runtimeEffects: [{ operation: "stop", stackId: "stack-main-default" }],
      details: {
        managed_stack_stopped: true,
        legacy_stack_stopped: false,
        legacy_state_mutated: false,
      },
      output: {
        json: {
          outcome: "update",
          stack_id: "stack-main-default",
          managed_stack_stopped: true,
          legacy_stack_stopped: false,
        },
      },
    },
  },
]);

const additionalApiBoundaryContractFixtures = defineManagedStackContractFixtures([
  {
    id: "api-boundary.managed-api-accepts-injected-repository",
    title: "The managed API accepts an injected repository without CLI ownership",
    area: "api-boundary",
    given: [
      { kind: "workspace", mode: "git", path: "checkout-a" },
      {
        kind: "git-state",
        workspacePath: "checkout-a",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git",
        head: "branch",
        branch: "main",
        commit: "commit-a",
      },
      {
        kind: "managed-api-options",
        stateRoot: "isolated",
        stateRootPath: "/tmp/managed-contract",
        repository: "injected",
        repositoryId: "test-repository",
        runtime: "node",
      },
    ],
    when: {
      interface: "managed-api",
      method: "createManagedStackService",
      input: { repository: "test-repository", stateRoot: "/tmp/managed-contract" },
    },
    expected: {
      outcome: "create",
      writes: [{ target: "ephemeral-state", operation: "create", id: "test-repository" }],
      runtimeEffects: [],
      details: { cli_required: false, repository_injected: true },
      output: {
        api: {
          service: "managed-stack-service",
          repository: "test-repository",
          cliRequired: false,
        },
      },
    },
  },
  {
    id: "api-boundary.managed-api-accepts-isolated-state-root",
    title: "The managed API can run against an isolated caller-provided state root",
    area: "api-boundary",
    given: [
      { kind: "managed-target", stackId: "stack-main-default", exists: false },
      { kind: "identity-claim", scope: "project", id: "project-a", status: "absent" },
      { kind: "identity-claim", scope: "checkout", id: "checkout-a", status: "absent" },
      { kind: "identity-claim", scope: "context", id: "context-main", status: "absent" },
      { kind: "workspace", mode: "git", path: "checkout-a" },
      {
        kind: "git-state",
        workspacePath: "checkout-a",
        commonDirectory: "repo/.git",
        gitDirectory: "repo/.git",
        head: "branch",
        branch: "main",
        commit: "commit-a",
      },
      {
        kind: "managed-api-options",
        stateRoot: "isolated",
        stateRootPath: "/tmp/managed-contract",
        repository: "in-memory",
        runtime: "bun",
      },
    ],
    when: {
      interface: "managed-api",
      method: "resolveStack",
      input: { cwd: "checkout-a", stackName: "default", stateRoot: "/tmp/managed-contract" },
    },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [
        { target: "git-config", operation: "create", id: "project-a", scope: "common" },
        { target: "git-config", operation: "create", id: "checkout-a", scope: "worktree" },
        {
          target: "git-config",
          operation: "create",
          id: "context-main",
          scope: "worktree",
          owner: "main",
        },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "managed-state", operation: "create", id: "stack-main-default" },
      ],
      runtimeEffects: [],
      details: {
        state_root: "/tmp/managed-contract",
        project_identity_storage: "git-local",
        default_system_state_mutated: false,
      },
      output: {
        api: { projectId: "project-a", checkoutId: "checkout-a", stackId: "stack-main-default" },
      },
    },
  },
  {
    id: "api-boundary.repository-contract-is-storage-agnostic",
    title: "The same repository contract produces identical decisions across storage adapters",
    area: "api-boundary",
    given: [
      {
        kind: "managed-api-options",
        stateRoot: "isolated",
        repository: "in-memory",
        runtime: "node",
      },
      {
        kind: "managed-api-options",
        stateRoot: "isolated",
        repository: "persistent-adapter",
        runtime: "node",
      },
    ],
    when: {
      interface: "managed-api",
      method: "runRepositoryContract",
      input: {
        adapters: ["in-memory", "persistent-adapter"],
        scenarioId: "identity.return-to-branch-reuses-stack",
      },
    },
    expected: {
      outcome: "report",
      writes: [],
      runtimeEffects: [],
      details: { decisions_equal: true, persistence_semantics_leaked: false },
      output: {
        api: {
          "in-memory": { outcome: "reuse", stackId: "stack-main-default" },
          "persistent-adapter": { outcome: "reuse", stackId: "stack-main-default" },
          equal: true,
        },
      },
    },
  },
  {
    id: "api-boundary.cli-projects-shared-managed-results",
    title: "The CLI projects one shared managed result instead of deciding identity twice",
    area: "api-boundary",
    given: [
      {
        kind: "managed-api-options",
        stateRoot: "default",
        repository: "persistent-adapter",
        runtime: "bun",
      },
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
      { kind: "managed-record", stackId: "stack-main-default", status: "active" },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "running",
      },
      { kind: "persisted-runtime", stackId: "stack-main-default", runtime: "docker" },
    ],
    when: {
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "report",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [],
      runtimeEffects: [],
      details: { identity_decisions_in_cli: 0, managed_result_projected: true },
      output: {
        human: {
          summary: "main/default is running",
          fields: { stackId: "stack-main-default", runtime: "docker" },
        },
        json: {
          outcome: "report",
          project_id: "project-a",
          checkout_id: "checkout-a",
          context_id: "context-main",
          stack_id: "stack-main-default",
          runtime: "docker",
        },
      },
    },
  },
  {
    id: "api-boundary.managed-surface-is-node-and-bun-portable",
    title: "The managed service contract has the same public result under Node and Bun",
    area: "api-boundary",
    given: [
      {
        kind: "managed-api-options",
        stateRoot: "isolated",
        repository: "in-memory",
        runtime: "node",
      },
      {
        kind: "managed-api-options",
        stateRoot: "isolated",
        repository: "in-memory",
        runtime: "bun",
      },
    ],
    when: {
      interface: "managed-api",
      method: "runPortableContract",
      input: {
        runtimes: ["node", "bun"],
        scenarioId: "identity.same-checkout-branch-and-name-reuses-stack",
      },
    },
    expected: {
      outcome: "report",
      writes: [],
      runtimeEffects: [],
      details: { results_equal: true, bun_specific_state_api: false },
      output: {
        api: {
          node: { outcome: "report", stackId: "stack-main-default" },
          bun: { outcome: "report", stackId: "stack-main-default" },
          equal: true,
        },
      },
    },
  },
]);

export const managedStackContractFixtures = defineManagedStackContractFixtures([
  ...additionalIdentityContractFixtures,
  ...additionalPortContractFixtures,
  ...additionalRuntimeContractFixtures,
  ...additionalLifecycleContractFixtures,
  ...additionalApiBoundaryContractFixtures,
  {
    id: "identity.return-to-branch-reuses-stack",
    title: "Returning to a previously used branch reuses its stack",
    area: "identity",
    given: [
      {
        kind: "checkout",
        path: "checkout-a",
        projectId: "project-a",
        checkoutId: "checkout-a",
      },
      {
        kind: "branch",
        name: "main",
        contextId: "context-main",
        checkedOut: true,
      },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "reuse",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [{ target: "runtime-state", operation: "start", id: "stack-main-default" }],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      output: {
        human: {
          summary: "Reused main/default",
          fields: {
            branch: "main",
            stack: "default",
            stackId: "stack-main-default",
          },
        },
        json: {
          outcome: "reuse",
          project_id: "project-a",
          checkout_id: "checkout-a",
          context_id: "context-main",
          stack_id: "stack-main-default",
          stack_name: "default",
        },
      },
    },
  },
  {
    id: "identity.branch-copy-ambiguous-read-only",
    title: "An ambiguous copied branch is reported without mutation",
    area: "identity",
    given: [
      {
        kind: "checkout",
        path: "checkout-a",
        projectId: "project-a",
        checkoutId: "checkout-a",
      },
      {
        kind: "branch",
        name: "main",
        contextId: "context-main",
        checkedOut: false,
      },
      {
        kind: "branch",
        name: "feat-copy",
        contextId: "context-main",
        checkedOut: true,
      },
    ],
    when: {
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "error",
      error: {
        code: "ambiguous_context_owner",
        message: "Branches feat-copy and main both claim context-main",
        recovery: [
          "supabase stack inspect --context-id context-main",
          "supabase stack new-context --branch feat-copy",
        ],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        human: {
          summary: "Cannot determine which branch owns this stack context",
          fields: {
            contextId: "context-main",
            branches: "feat-copy, main",
          },
          recovery: [
            "supabase stack inspect --context-id context-main",
            "supabase stack new-context --branch feat-copy",
          ],
        },
        json: {
          outcome: "error",
          code: "ambiguous_context_owner",
          context_id: "context-main",
          branches: ["feat-copy", "main"],
          recovery: [
            "supabase stack inspect --context-id context-main",
            "supabase stack new-context --branch feat-copy",
          ],
        },
      },
    },
  },
  {
    id: "ports.explicit-port-conflict-fails",
    title: "An occupied declarative port fails without relocation",
    area: "ports",
    given: [
      {
        kind: "config-port",
        key: "api.port",
        intent: "exact",
        value: 54321,
      },
      {
        kind: "occupied-port",
        port: 54321,
        owner: "external-process",
      },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "error",
      error: {
        code: "exact_port_occupied",
        message: "api.port requires 54321, but that port is already in use",
        recovery: [
          "Stop the process using port 54321",
          "Change api.port in supabase/config.toml",
          "Remove api.port to use automatic allocation",
        ],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        human: {
          summary: "Cannot start because configured port 54321 is in use",
          fields: {
            port: "54321",
            configKey: "api.port",
            owner: "external-process",
          },
          recovery: [
            "Stop the process using port 54321",
            "Change api.port in supabase/config.toml",
            "Remove api.port to use automatic allocation",
          ],
        },
        json: {
          outcome: "error",
          code: "exact_port_occupied",
          port: 54321,
          config_key: "api.port",
          owner: "external-process",
          recovery: [
            "Stop the process using port 54321",
            "Change api.port in supabase/config.toml",
            "Remove api.port to use automatic allocation",
          ],
        },
      },
    },
  },
  {
    id: "ports.explicit-port-conflict-with-sibling-fails",
    title: "A sibling managed stack holding a declarative port is identified precisely",
    area: "ports",
    given: [
      {
        kind: "checkout",
        path: "worktree-feat-a",
        projectId: "project-a",
        checkoutId: "checkout-feat-a",
      },
      { kind: "branch", name: "feat-a", contextId: "context-feat-a", checkedOut: true },
      { kind: "managed-target", stackId: "stack-feat-a-default", exists: false },
      {
        kind: "config-port",
        key: "api.port",
        intent: "exact",
        value: 54321,
        source: "local",
      },
      {
        kind: "occupied-port",
        port: 54321,
        owner: "managed-stack",
        ownerId: "stack-main-default",
      },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental"],
      cwd: "worktree-feat-a",
    },
    expected: {
      outcome: "error",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-feat-a",
        contextId: "context-feat-a",
        stackId: "stack-feat-a-default",
        stackName: "default",
      },
      error: {
        code: "exact_port_occupied",
        message: "api.port requires 54321, but stack-main-default already owns that port",
        recovery: [
          "Stop managed stack stack-main-default",
          "Change api.port in supabase/config.toml",
          "Remove api.port to let sibling stacks allocate independent ports",
        ],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        human: {
          summary: "Cannot start because a sibling stack uses configured port 54321",
          fields: {
            port: "54321",
            configKey: "api.port",
            owner: "managed-stack",
            ownerStackId: "stack-main-default",
          },
          recovery: [
            "Stop managed stack stack-main-default",
            "Change api.port in supabase/config.toml",
            "Remove api.port to let sibling stacks allocate independent ports",
          ],
        },
        json: {
          outcome: "error",
          code: "exact_port_occupied",
          port: 54321,
          config_key: "api.port",
          owner: "managed-stack",
          owner_stack_id: "stack-main-default",
          recovery: [
            "Stop managed stack stack-main-default",
            "Change api.port in supabase/config.toml",
            "Remove api.port to let sibling stacks allocate independent ports",
          ],
        },
      },
    },
  },
  {
    id: "runtime.persisted-runtime-conflict-fails",
    title: "An existing stack cannot be switched to another runtime by start",
    area: "runtime",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
      {
        kind: "stack",
        name: "default",
        stackId: "stack-main-default",
        contextId: "context-main",
        lifecycle: "stopped",
      },
      {
        kind: "persisted-runtime",
        stackId: "stack-main-default",
        runtime: "docker",
      },
      {
        kind: "runtime-request",
        source: "cli",
        runtime: "native",
      },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental", "--runtime", "native"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "error",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      error: {
        code: "runtime_conflicts_with_persisted_stack",
        message: "stack-main-default uses docker, but start requested native",
        recovery: [
          "Start a new named stack with --stack <name>",
          "Delete and recreate stack-main-default",
        ],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        human: {
          summary: "Cannot change the runtime of an existing stack",
          fields: {
            stackId: "stack-main-default",
            persistedRuntime: "docker",
            requestedRuntime: "native",
          },
          recovery: [
            "Start a new named stack with --stack <name>",
            "Delete and recreate stack-main-default",
          ],
        },
        json: {
          outcome: "error",
          code: "runtime_conflicts_with_persisted_stack",
          stack_id: "stack-main-default",
          persisted_runtime: "docker",
          requested_runtime: "native",
          recovery: [
            "Start a new named stack with --stack <name>",
            "Delete and recreate stack-main-default",
          ],
        },
      },
    },
  },
  {
    id: "bootstrap.first-start-copies-compatible-legacy-state",
    title: "First experimental start copies compatible stopped legacy state",
    area: "bootstrap",
    given: [
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      { kind: "branch", name: "main", contextId: "context-main", checkedOut: true },
      {
        kind: "managed-target",
        stackId: "stack-main-default",
        exists: false,
      },
      {
        kind: "legacy-state",
        lifecycle: "stopped",
        database: "compatible",
        storage: "compatible",
        credentials: "compatible",
      },
    ],
    when: {
      interface: "cli",
      argv: ["start", "--experimental"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "create",
      selection: {
        projectId: "project-a",
        checkoutId: "checkout-a",
        contextId: "context-main",
        stackId: "stack-main-default",
        stackName: "default",
      },
      writes: [
        { target: "managed-state", operation: "copy", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [
        { operation: "copy", stackId: "stack-main-default" },
        { operation: "start", stackId: "stack-main-default" },
      ],
      details: {
        bootstrap: "copied",
        legacy_state_mutated: false,
        credentials: "preserved",
      },
      output: {
        human: {
          summary: "Created main/default from compatible legacy state",
          fields: {
            stack: "default",
            stackId: "stack-main-default",
            bootstrap: "copied",
            credentials: "preserved",
          },
        },
        json: {
          outcome: "create",
          bootstrap: "copied",
          stack_id: "stack-main-default",
          credentials: "preserved",
          legacy_state_mutated: false,
        },
      },
    },
  },
  {
    id: "reclamation.delete-orphan-by-stack-id",
    title: "An orphaned stack can be deleted globally by opaque ID",
    area: "reclamation",
    given: [
      {
        kind: "stack",
        name: "default",
        stackId: "stack-orphan",
        contextId: "context-orphan",
        lifecycle: "running",
        orphaned: true,
      },
    ],
    when: {
      interface: "cli",
      argv: ["stop", "--experimental", "--stack-id", "stack-orphan", "--no-backup"],
      cwd: "outside-any-checkout",
    },
    expected: {
      outcome: "delete",
      writes: [
        { target: "runtime-state", operation: "delete", id: "stack-orphan" },
        { target: "managed-state", operation: "delete", id: "stack-orphan" },
        { target: "registry", operation: "tombstone", id: "stack-orphan" },
      ],
      runtimeEffects: [
        { operation: "stop", stackId: "stack-orphan" },
        { operation: "delete", stackId: "stack-orphan" },
      ],
      details: {
        tombstoned: true,
        checkout_required: false,
      },
      output: {
        human: {
          summary: "Deleted managed stack stack-orphan",
          fields: {
            stackId: "stack-orphan",
            orphaned: "true",
            tombstoned: "true",
          },
        },
        json: {
          outcome: "delete",
          stack_id: "stack-orphan",
          orphaned: true,
          tombstoned: true,
        },
      },
    },
  },
  {
    id: "api-boundary.direct-create-stack-is-ephemeral",
    title: "Direct createStack usage is isolated from managed system state",
    area: "api-boundary",
    given: [
      {
        kind: "direct-stack-options",
        roots: "omitted",
      },
    ],
    when: {
      interface: "stack-api",
      method: "createStack",
      input: {},
    },
    expected: {
      outcome: "create",
      writes: [{ target: "ephemeral-state", operation: "create", id: "ephemeral-stack" }],
      runtimeEffects: [],
      details: {
        git_inspected: false,
        identity_marker_created: false,
        global_registry_mutated: false,
        state_root: "temporary",
      },
      output: {
        api: {
          handle: "stack-handle",
          state_root: "temporary",
        },
      },
    },
  },
]);
