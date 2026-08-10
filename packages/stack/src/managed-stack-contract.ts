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
      readonly owner: "external-process" | "legacy-stack" | "managed-stack";
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
      readonly plaintextPresentInGlobalState?: boolean;
    }
  | {
      readonly kind: "direct-stack-options";
      readonly roots: "explicit" | "omitted";
    }
  | {
      readonly kind: "managed-api-options";
      readonly stateRoot: "default" | "isolated";
      readonly repository: "in-memory" | "injected" | "persistent-adapter";
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
    }
  | {
      readonly target:
        | "ephemeral-state"
        | "identity-marker"
        | "managed-state"
        | "registry"
        | "runtime-state";
      readonly operation:
        | "copy"
        | "create"
        | "delete"
        | "publish"
        | "start"
        | "tombstone"
        | "update";
      readonly id?: string;
    };

export interface ManagedStackContractEffects {
  readonly writes: ReadonlyArray<ManagedStackContractWrite>;
  readonly runtimeEffects: ReadonlyArray<{
    readonly operation: "copy" | "delete" | "start" | "stop";
    readonly stackId?: string;
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

export const validateManagedStackContractFixtures = (
  fixtures: ReadonlyArray<ManagedStackContractScenario>,
): ReadonlyArray<string> => {
  const errors: Array<string> = [];
  const ids = new Set<string>();
  const nativeServices = managedNativeServiceMatrix.services.map(([service]) => service);
  const nativeServiceSet = new Set<ServiceName>(nativeServices);

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
          break;
        case "credential-state":
          declaredIds.add(fact.valuesId);
          if (fact.previousValuesId !== undefined) {
            declaredIds.add(fact.previousValuesId);
          }
          break;
        case "identity-claim":
          declaredIds.add(fact.id);
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
        case "managed-record":
        case "managed-target":
        case "persisted-runtime":
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

    for (const fact of scenario.given) {
      if (fact.kind !== "native-qualification") {
        continue;
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
        if (effect.operation !== "start" || effect.stackId === undefined) {
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

    for (const write of scenario.expected.writes) {
      if (
        write.id !== undefined &&
        (write.operation === "copy" ||
          write.operation === "create" ||
          write.operation === "publish")
      ) {
        declaredIds.add(write.id);
      }
    }
    for (const write of scenario.expected.writes) {
      if (
        write.id !== undefined &&
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
      }
    }

    for (const write of scenario.expected.writes) {
      if (write.target !== "git-config") {
        continue;
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
    }

    for (const effect of scenario.expected.runtimeEffects) {
      if (effect.stackId !== undefined && !declaredIds.has(effect.stackId)) {
        errors.push(`${scenario.id}: runtime effect references undeclared ID ${effect.stackId}`);
      }

      const hasWrite = scenario.expected.writes.some((write) => {
        if (write.id !== effect.stackId) {
          return false;
        }
        switch (effect.operation) {
          case "copy":
            return write.target === "managed-state" && write.operation === "copy";
          case "delete":
            return (
              (write.target === "managed-state" || write.target === "runtime-state") &&
              write.operation === "delete"
            );
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

      const requiredRuntimeOperation =
        write.target === "runtime-state" && write.operation === "start"
          ? "start"
          : write.target === "runtime-state" && write.operation === "update"
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
        { target: "git-config", operation: "create", id: "context-feat-a", scope: "worktree" },
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
        { target: "git-config", operation: "update", id: "context-feat", scope: "worktree" },
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
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
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
        { target: "git-config", operation: "create", id: "context-new", scope: "worktree" },
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
      { kind: "checkout", path: "checkout-a", projectId: "project-a", checkoutId: "checkout-a" },
      {
        kind: "identity-transition",
        operation: "ref-replacement",
        from: "commit-a",
        to: "commit-b",
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
        { target: "git-config", operation: "create", id: "context-new", scope: "worktree" },
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
    id: "identity.non-git-folder-reuses-workspace-context",
    title: "A non-Git folder reuses one workspace-scoped context",
    area: "identity",
    given: [
      {
        kind: "workspace",
        mode: "ordinary-folder",
        path: "project-a",
        canonicalPath: "/work/project-a",
      },
      {
        kind: "checkout",
        path: "/work/project-a",
        projectId: "project-a",
        checkoutId: "checkout-a",
      },
      { kind: "branch", name: "(workspace)", contextId: "context-workspace", checkedOut: true },
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
        { target: "git-config", operation: "create", id: "context-b-main", scope: "worktree" },
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
      { kind: "workspace", mode: "git", path: "/clone/project-a", clonedFrom: "/work/project-a" },
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
        json: { outcome: "error", code: "checkout_path_inaccessible", checkout_id: "checkout-a" },
      },
    },
  },
  {
    id: "identity.concurrent-create-publishes-once",
    title: "Concurrent creation publishes one stack without aliases",
    area: "identity",
    given: [
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
  {
    id: "identity.invalid-stack-name-fails",
    title: "Invalid stack names fail before registration",
    area: "identity",
    given: [{ kind: "stack-names", names: ["Feature_A", "-review", "review..two"] }],
    when: {
      interface: "cli",
      argv: ["start", "--experimental", "--stack", "Feature_A"],
      cwd: "checkout-a",
    },
    expected: {
      outcome: "error",
      error: {
        code: "invalid_stack_name",
        message: "Feature_A is not a lowercase DNS-label name",
        recovery: ["Use default or a lowercase DNS-label name such as feature-a"],
      },
      writes: [],
      runtimeEffects: [],
      output: {
        human: {
          summary: "Invalid stack name: Feature_A",
          fields: { stack: "Feature_A" },
          recovery: ["Use default or a lowercase DNS-label name such as feature-a"],
        },
        json: { outcome: "error", code: "invalid_stack_name", stack_name: "Feature_A" },
      },
    },
  },
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
        { target: "git-config", operation: "update", id: "context-copy", scope: "worktree" },
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
        { target: "git-config", operation: "update", id: "context-main", scope: "worktree" },
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
        { target: "git-config", operation: "create", id: "context-main", scope: "worktree" },
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
      {
        kind: "identity-transition",
        operation: "folder-to-git",
        from: "ordinary-folder",
        to: "git",
      },
      { kind: "workspace", mode: "git", path: "/work/project-a", canonicalPath: "/work/project-a" },
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
        { target: "git-config", operation: "create", id: "context-git-main", scope: "worktree" },
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
        { target: "git-config", operation: "create", id: "checkout-b", scope: "worktree" },
        { target: "git-config", operation: "create", id: "context-b-main", scope: "worktree" },
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
      { kind: "managed-target", stackId: "stack-feat-default", exists: false },
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
    title: "Sibling branches, worktrees, and named stacks allocate independent automatic ports",
    area: "ports",
    given: [
      {
        kind: "port-assignment",
        stackId: "stack-main-default",
        key: "api.port",
        port: 55421,
        intent: "automatic",
      },
      {
        kind: "port-assignment",
        stackId: "stack-feat-default",
        key: "api.port",
        port: 55422,
        intent: "automatic",
      },
      {
        kind: "port-assignment",
        stackId: "stack-worktree-default",
        key: "api.port",
        port: 55423,
        intent: "automatic",
      },
      {
        kind: "port-assignment",
        stackId: "stack-main-review",
        key: "api.port",
        port: 55424,
        intent: "automatic",
      },
    ],
    when: { interface: "managed-api", method: "listStackPorts", input: { projectId: "project-a" } },
    expected: {
      outcome: "report",
      writes: [],
      runtimeEffects: [],
      output: {
        api: {
          "stack-main-default": { api: 55421 },
          "stack-feat-default": { api: 55422 },
          "stack-worktree-default": { api: 55423 },
          "stack-main-review": { api: 55424 },
        },
      },
    },
  },
  {
    id: "ports.sticky-ports-reuse-on-return",
    title: "Returning to an existing target reuses its sticky automatic ports",
    area: "ports",
    given: [
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
        },
      },
    },
  },
  {
    id: "ports.config-change-on-stopped-stack-applies",
    title: "Changing an exact port on a stopped stack applies on next start",
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
      { kind: "runtime-request", source: "config", runtime: "native" },
      { kind: "runtime-request", source: "default", runtime: "auto" },
      { kind: "runtime-availability", runtime: "native", available: true },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
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
          fallback_attempted: false,
        },
      },
    },
  },
  {
    id: "runtime.persisted-runtime-reused-for-auto",
    title: "An existing stack reuses its persisted runtime for omitted or automatic selection",
    area: "runtime",
    given: [
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
      { kind: "persisted-runtime", stackId: "stack-main-default", runtime: "native" },
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
        },
      },
    },
  },
  {
    id: "runtime.status-reports-one-stack-wide-runtime",
    title: "Status reports one persisted stack-wide runtime and any drift",
    area: "runtime",
    given: [
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
      details: { qualified: true, qualified_service_count: 13 },
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
      details: { reduced_graph: false, docker_fallback_per_service: false },
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
        },
      },
    },
  },
]);

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
        },
      },
    },
  },
  {
    id: "bootstrap.failed-copy-rolls-back-and-retries",
    title: "A failed bootstrap leaves no active target and the same start retries safely",
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
        retry_is_same_command: true,
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
    id: "bootstrap.managed-and-legacy-diverge-after-copy",
    title: "Managed starts never reread legacy state after a successful bootstrap",
    area: "bootstrap",
    given: [
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
    title: "Configured auth values are authoritative for a new managed stack",
    area: "credentials",
    given: [{ kind: "credential-state", source: "configured", valuesId: "configured-auth-v1" }],
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
      details: { credential_values_id: "configured-auth-v1", source: "configured" },
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
      { kind: "credential-state", source: "local-default", valuesId: "stable-local-defaults-v1" },
    ],
    when: { interface: "cli", argv: ["start", "--experimental"], cwd: "checkout-a" },
    expected: {
      outcome: "create",
      writes: [
        { target: "managed-state", operation: "create", id: "stack-main-default" },
        { target: "registry", operation: "publish", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
      details: { credential_values_id: "stable-local-defaults-v1", generated_per_start: false },
      output: {
        json: {
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
      writes: [
        { target: "managed-state", operation: "update", id: "stack-main-default" },
        { target: "runtime-state", operation: "start", id: "stack-main-default" },
      ],
      runtimeEffects: [{ operation: "start", stackId: "stack-main-default" }],
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
      details: { credential_values_id: "legacy-auth-v1", legacy_state_mutated: false },
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
    id: "credentials.plaintext-secrets-stay-out-of-global-state",
    title: "Resolved plaintext secrets are absent from the global managed registry",
    area: "credentials",
    given: [
      {
        kind: "credential-state",
        source: "persisted",
        valuesId: "configured-auth-v1",
        plaintextPresentInGlobalState: false,
      },
      { kind: "managed-record", stackId: "stack-main-default", status: "active" },
    ],
    when: {
      interface: "managed-api",
      method: "inspectGlobalRecord",
      input: { stackId: "stack-main-default" },
    },
    expected: {
      outcome: "report",
      writes: [],
      runtimeEffects: [],
      details: { plaintext_secrets_present: false },
      output: {
        api: {
          stackId: "stack-main-default",
          credentialsReference: "configured-auth-v1",
          plaintextSecrets: [],
        },
      },
    },
  },
  {
    id: "reclamation.default-stop-preserves-data",
    title: "Default experimental stop preserves managed data",
    area: "reclamation",
    given: [
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
      details: { stack_data_preserved: true, stack_orphaned: true },
      output: { human: { summary: "Deleted branch feat-a", fields: {} } },
    },
  },
  {
    id: "reclamation.prune-removes-metadata-only",
    title: "Prune removes orphan metadata without deleting mutable stack data",
    area: "reclamation",
    given: [{ kind: "managed-record", stackId: "stack-orphan", status: "orphaned" }],
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
  {
    id: "reclamation.selectors-are-mutually-exclusive",
    title: "Contextual, named, global-ID, and all-stack selectors cannot be combined",
    area: "reclamation",
    given: [{ kind: "managed-record", stackId: "stack-main-default", status: "active" }],
    when: {
      interface: "cli",
      argv: [
        "stop",
        "--experimental",
        "--stack",
        "review",
        "--stack-id",
        "stack-main-default",
        "--all",
      ],
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
          fields: { selectors: "--stack, --stack-id, --all" },
          recovery: ["Remove all but one stack selector"],
        },
        json: { outcome: "error", code: "mutually_exclusive_stack_selectors" },
      },
    },
  },
  {
    id: "reclamation.stop-is-engine-scoped",
    title: "Experimental stop affects the selected managed stack and never the legacy engine",
    area: "reclamation",
    given: [
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
        repository: "injected",
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
        { target: "git-config", operation: "create", id: "context-main", scope: "worktree" },
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
          node: { outcome: "reuse", stackId: "stack-main-default" },
          bun: { outcome: "reuse", stackId: "stack-main-default" },
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
