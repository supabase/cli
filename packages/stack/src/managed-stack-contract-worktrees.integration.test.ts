import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, type FileSystem } from "effect";
import {
  git,
  makeBareRepository,
  makeRepository,
  storedConfigValue,
  temporaryRoots,
} from "../tests/helpers/git-workspace.ts";
import {
  managedStackContractFixtures,
  type ManagedStackContractScenario,
} from "./managed-stack-contract.ts";
import {
  createManagedStackService,
  ensureBranchContextId,
  ensureGitCheckoutIdentity,
  GIT_PROJECT_ID_KEY,
  gitBranchContextIdKey,
  gitCheckoutIdentityPath,
  gitConfigPath,
  gitConfigStoreLayer,
  InvalidManagedStackNameError,
  inspectWorkspace,
  makeManagedStackService,
  type EnsureGitCheckoutIdentityResult,
  type GitCheckoutInspection,
  type ManagedCheckoutKind,
  type ManagedStackRecord,
  type ManagedStackResolution,
  type ManagedStackSelection,
  type ManagedStackServiceHandle,
  type ResolveManagedStackRequest,
} from "./managed-bun.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";

/**
 * The normative worktree and named-stack isolation fixtures, driven against the
 * real managed service.
 *
 * The fixtures in `managed-stack-contract.ts` state their `given` and `expected`
 * in symbolic ids — `project-a`, `checkout-b`, `context-main` — and those symbols
 * are *equality relations*, never literal values. Two facts naming one symbol
 * require one real id; two different symbols require two different real ids. So
 * every test here builds the scenario's workspace with the git binary, drives the
 * scenario's `when` through the service, and hands each expected id to a binding
 * map that enforces exactly those relations (see {@link symbolBindings}).
 *
 * Nothing is asserted against a hand-written literal a fixture edit would leave
 * behind: stack names, branch names, workspace layout, the outcome, the writes,
 * and the runtime effects are all read out of the scenario. Editing a fixture
 * changes what these tests do — and a write or effect this harness cannot check
 * is an error rather than a silent pass, so a fixture cannot grow past it.
 *
 * Two classes of `given` fact are provided by construction rather than asserted:
 * `managed-target ... exists: false` and `legacy-state ... absent` describe a
 * registry and a state root nothing has been created in yet, which every test
 * gets from its own temporary root.
 */

const { makeRoot, removeAll } = temporaryRoots("managed-contract-worktree-");

const openHandles: Array<ManagedStackServiceHandle> = [];

afterEach(async () => {
  for (const handle of openHandles.splice(0)) {
    await handle.close();
  }
  removeAll();
});

/** Both adapters owe identical observable semantics, so every case runs on both. */
const adapters = [
  [
    "in-memory",
    (root: string): Promise<ManagedStackServiceHandle> =>
      makeManagedStackService({
        repository: createInMemoryManagedStackRepository(),
        stateRoot: join(root, "managed"),
        publicationPollMs: 1,
      }),
  ],
  [
    "sqlite",
    (root: string): Promise<ManagedStackServiceHandle> =>
      createManagedStackService({ stateRoot: join(root, "managed"), publicationPollMs: 1 }),
  ],
] as const;

const runRepo = Effect.runSync;

const fixture = (id: string): ManagedStackContractScenario => {
  const scenario = managedStackContractFixtures.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`Missing managed stack contract fixture ${id}`);
  }
  return scenario;
};

/**
 * A scenario's `given` facts, each looked up by what makes it unique. A scenario
 * that does not state the fact a test is built on is a broken harness rather than
 * a failing expectation, so these throw.
 */

const workspaceFacts = (scenario: ManagedStackContractScenario) =>
  scenario.given.flatMap((fact) => (fact.kind === "workspace" ? [fact] : []));

const worktreePair = (scenario: ManagedStackContractScenario) => {
  const [first, second, ...rest] = workspaceFacts(scenario);
  if (first === undefined || second === undefined || rest.length > 0) {
    throw new Error(`${scenario.id} states no pair of worktrees`);
  }
  return [first, second] as const;
};

const checkoutFact = (scenario: ManagedStackContractScenario, path: string) => {
  const fact = scenario.given.find(
    (candidate) => candidate.kind === "checkout" && candidate.path === path,
  );
  if (fact?.kind !== "checkout") {
    throw new Error(`${scenario.id} states no checkout at ${path}`);
  }
  return fact;
};

const branchFacts = (scenario: ManagedStackContractScenario) =>
  scenario.given.flatMap((fact) => (fact.kind === "branch" ? [fact] : []));

const onlyBranchFact = (scenario: ManagedStackContractScenario) => {
  const [fact, ...rest] = branchFacts(scenario);
  if (fact === undefined || rest.length > 0) {
    throw new Error(`${scenario.id} states ${branchFacts(scenario).length} branches, not one`);
  }
  return fact;
};

/** The branch a scenario's checkout is on when its `when` runs. */
const checkedOutBranchFact = (scenario: ManagedStackContractScenario) => {
  const fact = branchFacts(scenario).find((candidate) => candidate.checkedOut);
  if (fact === undefined) {
    throw new Error(`${scenario.id} states no checked-out branch`);
  }
  return fact;
};

/** The branch a scenario knows about but is not on. */
const idleBranchFact = (scenario: ManagedStackContractScenario) => {
  const fact = branchFacts(scenario).find((candidate) => !candidate.checkedOut);
  if (fact === undefined) {
    throw new Error(`${scenario.id} states no branch that is not checked out`);
  }
  return fact;
};

const stackFacts = (scenario: ManagedStackContractScenario) =>
  scenario.given.flatMap((fact) => (fact.kind === "stack" ? [fact] : []));

const onlyStackFact = (scenario: ManagedStackContractScenario) => {
  const [fact, ...rest] = stackFacts(scenario);
  if (fact === undefined || rest.length > 0) {
    throw new Error(`${scenario.id} states ${stackFacts(scenario).length} stacks, not one`);
  }
  return fact;
};

const gitStateFact = (scenario: ManagedStackContractScenario, workspacePath: string) => {
  const fact = scenario.given.find(
    (candidate) => candidate.kind === "git-state" && candidate.workspacePath === workspacePath,
  );
  if (fact?.kind !== "git-state") {
    throw new Error(`${scenario.id} states no git state for ${workspacePath}`);
  }
  return fact;
};

const transitionFact = (scenario: ManagedStackContractScenario) => {
  const fact = scenario.given.find((candidate) => candidate.kind === "identity-transition");
  if (fact?.kind !== "identity-transition") {
    throw new Error(`${scenario.id} states no identity transition`);
  }
  return fact;
};

const stackNames = (scenario: ManagedStackContractScenario): ReadonlyArray<string> =>
  scenario.given.flatMap((fact) => (fact.kind === "stack-names" ? fact.names : []));

/** The branch a `git-state` fact says its workspace is on. */
const headBranch = (scenario: ManagedStackContractScenario, workspacePath: string): string => {
  const branch = gitStateFact(scenario, workspacePath).branch;
  if (branch === undefined) {
    throw new Error(`${scenario.id} states no branch for ${workspacePath}`);
  }
  return branch;
};

const detailString = (scenario: ManagedStackContractScenario, key: string): string => {
  const value = scenario.expected.details?.[key];
  if (typeof value !== "string") {
    throw new Error(`${scenario.id} states no ${key}`);
  }
  return value;
};

/** A detail a scenario must claim for a test to be discharging what it says. */
const requireDetail = (
  scenario: ManagedStackContractScenario,
  key: string,
  value: boolean,
): void => {
  const actual = scenario.expected.details?.[key];
  if (actual !== value) {
    throw new Error(`${scenario.id} states ${key} as ${String(actual)}, not ${String(value)}`);
  }
};

/** How a fixture's workspace mode names what the registry calls a checkout kind. */
const CHECKOUT_KIND_OF_MODE: Readonly<
  Record<ReturnType<typeof workspaceFacts>[number]["mode"], ManagedCheckoutKind>
> = {
  "bare-worktree": "bare-worktree",
  git: "git",
  "linked-worktree": "linked-worktree",
  "ordinary-folder": "ordinary",
};

/**
 * The bindings from a scenario's symbolic ids to the real ids a run produced.
 *
 * The first real value a symbol is bound to is the one every later use of that
 * symbol must equal, and no second symbol may claim a value another already
 * holds. That pair of rules is the whole of what the fixtures' ids mean: sharing
 * a symbol is an equality requirement, and using different symbols is a
 * distinctness requirement.
 */
const symbolBindings = (scenarioId: string) => {
  const valueOfSymbol = new Map<string, string>();
  const symbolOfValue = new Map<string, string>();
  const bind = (symbol: string, actual: string | undefined): string => {
    if (actual === undefined) {
      throw new Error(`${scenarioId} produced no value for ${symbol}`);
    }
    const known = valueOfSymbol.get(symbol);
    if (known !== undefined) {
      expect(actual, `${scenarioId}: ${symbol} must resolve to one id`).toBe(known);
      return known;
    }
    const owner = symbolOfValue.get(actual);
    expect(
      owner ?? symbol,
      `${scenarioId}: ${symbol} and ${owner} must resolve to different ids`,
    ).toBe(symbol);
    valueOfSymbol.set(symbol, actual);
    symbolOfValue.set(actual, symbol);
    return actual;
  };
  return {
    bind,
    valueOf: (symbol: string): string => {
      const known = valueOfSymbol.get(symbol);
      if (known === undefined) {
        throw new Error(`${scenarioId} has nothing bound to ${symbol}`);
      }
      return known;
    },
  };
};

type SymbolBindings = ReturnType<typeof symbolBindings>;

/**
 * The managed call a scenario's `when` amounts to.
 *
 * A CLI fixture states the very same call in argv, so `start` or `status` and an
 * optional `--stack` are read straight out of it: translating argv into this call
 * is the CLI layer's own job, and a later issue.
 */
const resolveCall = (
  scenario: ManagedStackContractScenario,
): {
  readonly cwd: string;
  readonly operation: "start" | "status";
  readonly stackName: string | undefined;
} => {
  const when = scenario.when;
  if (when.interface === "managed-api") {
    if (when.method !== "resolveStack") {
      throw new Error(`${scenario.id} calls ${when.method}, not resolveStack`);
    }
    const { cwd, operation, stackName } = when.input;
    if (typeof cwd !== "string") {
      throw new Error(`${scenario.id} states no cwd`);
    }
    if (operation !== "start" && operation !== "status") {
      throw new Error(`${scenario.id} states the unsupported operation ${String(operation)}`);
    }
    return { cwd, operation, stackName: typeof stackName === "string" ? stackName : undefined };
  }
  if (when.interface === "cli") {
    const [command] = when.argv;
    if (command !== "start" && command !== "status") {
      throw new Error(`${scenario.id} runs ${String(command)}, which resolves no stack`);
    }
    const stackFlag = when.argv.indexOf("--stack");
    return {
      cwd: when.cwd,
      operation: command,
      stackName: stackFlag === -1 ? undefined : when.argv[stackFlag + 1],
    };
  }
  throw new Error(`${scenario.id} acts through ${when.interface}`);
};

/** Where a scenario's identities live once its workspace is built. */
interface WorkspaceLocations {
  readonly commonDirectory: string;
  readonly gitDirectory: string;
  readonly branch?: string;
}

/** The locations of a primary checkout, whose git directory is the repository. */
const primaryLocations = (repository: string, branch?: string): WorkspaceLocations => ({
  commonDirectory: join(repository, ".git"),
  gitDirectory: join(repository, ".git"),
  branch,
});

/**
 * Everything one call could write, in one comparable value: the git-stored
 * identities, the registry's own view of its stacks and checkouts, and whether
 * any stack state exists at all. A scenario whose `expected.writes` is empty is
 * this being identical before and after its `when`.
 */
const stateWitness = async (service: ManagedStackServiceHandle, locations: WorkspaceLocations) => {
  const config = gitConfigPath(locations.commonDirectory);
  const marker = gitCheckoutIdentityPath(locations.gitDirectory);
  return {
    config: existsSync(config) ? readFileSync(config, "utf8") : undefined,
    checkoutMarker: existsSync(marker) ? readFileSync(marker, "utf8") : undefined,
    stacks: await service.listStacks({ includeTombstoned: true }),
    checkoutLocations: runRepo(service.repository.listCheckoutLocations()),
    stackState: existsSync(join(service.stateRoot, "stacks")),
  };
};

/** The claims a scenario states are absent, checked where the layer stores them. */
const expectAbsentClaims = (
  scenario: ManagedStackContractScenario,
  locations: WorkspaceLocations,
): void => {
  const config = gitConfigPath(locations.commonDirectory);
  for (const fact of scenario.given) {
    if (fact.kind !== "identity-claim" || fact.status !== "absent") {
      continue;
    }
    switch (fact.scope) {
      case "checkout": {
        expect(existsSync(gitCheckoutIdentityPath(locations.gitDirectory))).toBe(false);
        break;
      }
      case "context": {
        const branch = locations.branch;
        if (branch === undefined) {
          throw new Error(`${scenario.id} claims a context with no branch to own it`);
        }
        expect(storedConfigValue(config, gitBranchContextIdKey(branch))).toBeUndefined();
        break;
      }
      case "project": {
        expect(storedConfigValue(config, GIT_PROJECT_ID_KEY)).toBeUndefined();
        break;
      }
    }
  }
};

/** What a scenario's writes and runtime effects are checked against. */
interface ContractWitness extends WorkspaceLocations {
  readonly stackId: string;
  readonly paths: ManagedStackRecord["paths"];
  readonly lifecycle: ManagedStackRecord["lifecycle"] | undefined;
  readonly status: ManagedStackRecord["status"] | undefined;
  /** Whether the caller's runtime seam was asked to stop the stack. */
  readonly stopped: boolean;
}

/** The witness a resolution that settled on a stack provides. */
const witnessOf = (
  locations: WorkspaceLocations,
  stack: ManagedStackRecord,
  stopped = false,
): ContractWitness => ({
  ...locations,
  stackId: stack.id,
  paths: stack.paths,
  lifecycle: stack.lifecycle,
  status: stack.status,
  stopped,
});

/**
 * The writes a scenario lists, checked where the real system puts them.
 *
 * What a scenario does *not* list is checked by the bindings instead: an id it
 * says was already claimed is bound before the call runs, so a call that claimed
 * it again would bind a different value and fail.
 */
const verifyWrites = (
  bindings: SymbolBindings,
  scenario: ManagedStackContractScenario,
  witness: ContractWitness,
): void => {
  for (const write of scenario.expected.writes) {
    switch (write.target) {
      case "git-config": {
        // A branch context lives in the shared repository config, under the
        // branch that owns it.
        const branch = write.owner;
        if (branch === undefined) {
          throw new Error(`${scenario.id} writes ${write.id} with no owning branch`);
        }
        bindings.bind(
          write.id,
          storedConfigValue(gitConfigPath(witness.commonDirectory), gitBranchContextIdKey(branch)),
        );
        break;
      }
      case "registry": {
        bindings.bind(write.id, witness.stackId);
        if (write.operation === "publish") {
          expect(witness.status).toBe("active");
        } else if (write.operation === "tombstone") {
          expect(witness.status).toBe("tombstoned");
        } else {
          throw new Error(`${scenario.id} expects an unchecked registry ${write.operation}`);
        }
        break;
      }
      case "managed-state": {
        bindings.bind(write.id, witness.stackId);
        if (write.operation === "create") {
          expect(existsSync(witness.paths.root)).toBe(true);
        } else if (write.operation === "delete") {
          expect(existsSync(witness.paths.root)).toBe(false);
        } else {
          throw new Error(`${scenario.id} expects an unchecked managed-state ${write.operation}`);
        }
        break;
      }
      case "runtime-state": {
        bindings.bind(write.id, witness.stackId);
        if (write.operation === "start") {
          expect(witness.lifecycle).toBe("running");
        } else if (write.operation === "delete") {
          expect(witness.stopped).toBe(true);
        } else {
          throw new Error(`${scenario.id} expects an unchecked runtime-state ${write.operation}`);
        }
        break;
      }
      default: {
        throw new Error(
          `${scenario.id} writes to ${write.target}, which this harness cannot check`,
        );
      }
    }
  }
};

/** The runtime effects a scenario lists, checked through the seams they reach. */
const verifyRuntimeEffects = (
  bindings: SymbolBindings,
  scenario: ManagedStackContractScenario,
  witness: ContractWitness,
): void => {
  for (const effect of scenario.expected.runtimeEffects) {
    bindings.bind(effect.stackId, witness.stackId);
    switch (effect.operation) {
      case "start": {
        expect(witness.lifecycle).toBe("running");
        break;
      }
      case "stop": {
        expect(witness.stopped).toBe(true);
        break;
      }
      case "delete": {
        expect(existsSync(witness.paths.root)).toBe(false);
        break;
      }
      default: {
        throw new Error(`${scenario.id} expects an unchecked ${effect.operation} effect`);
      }
    }
  }
};

/** Binds a scenario's expected selection, which is where most of its ids are. */
const bindSelection = (
  bindings: SymbolBindings,
  scenario: ManagedStackContractScenario,
  actual: ManagedStackSelection,
): void => {
  const expected = scenario.expected.selection;
  if (expected === undefined) {
    throw new Error(`${scenario.id} states no selection`);
  }
  bindings.bind(expected.projectId, actual.projectId);
  bindings.bind(expected.checkoutId, actual.checkoutId);
  bindings.bind(expected.contextId, actual.contextId);
  bindings.bind(expected.stackId, actual.stackId);
  // The stack name is the literal a caller passes, not one of the symbolic ids.
  expect(actual.stackName).toBe(expected.stackName);
};

const requireSelection = (
  scenario: ManagedStackContractScenario,
  resolution: ManagedStackResolution,
): ManagedStackSelection => {
  const selection = resolution.selection;
  if (selection === undefined) {
    throw new Error(`${scenario.id} resolved no stack`);
  }
  return selection;
};

const gitLayer = Layer.mergeAll(BunFileSystem.layer, gitConfigStoreLayer);

const inspectCheckout = (
  path: string,
): Effect.Effect<GitCheckoutInspection, never, FileSystem.FileSystem> =>
  Effect.flatMap(inspectWorkspace(path), (inspection) =>
    inspection.kind === "git-checkout"
      ? Effect.succeed(inspection)
      : Effect.die(new Error(`${path} was classified as ${inspection.kind}`)),
  ).pipe(Effect.orDie);

/**
 * The `given` fact that a checkout is already known, established the way the
 * managed layer establishes it — and nothing beyond it, so a scenario whose
 * expected writes still include a context can start from a claimed checkout.
 */
const claimCheckout = (path: string): Promise<EnsureGitCheckoutIdentityResult> =>
  Effect.runPromise(
    Effect.flatMap(inspectCheckout(path), (inspection) =>
      ensureGitCheckoutIdentity(inspection),
    ).pipe(Effect.orDie, Effect.provide(gitLayer)),
  );

/** The `given` fact that a branch already has a context, with no stack in it. */
const claimBranchContext = (path: string, branch: string): Promise<string> =>
  Effect.runPromise(
    Effect.flatMap(inspectCheckout(path), (inspection) =>
      ensureBranchContextId(inspection, branch),
    ).pipe(Effect.orDie, Effect.provide(gitLayer)),
  );

/** The repository's initial branch, named as the scenario names it. */
const nameInitialBranch = (repository: string, branch: string): void => {
  if (git(repository, "rev-parse", "--abbrev-ref", "HEAD").trim() !== branch) {
    git(repository, "branch", "-m", branch);
  }
};

const currentBranch = (repository: string): string =>
  git(repository, "rev-parse", "--abbrev-ref", "HEAD").trim();

/**
 * A running stack on a port of its own, so a start reserves what a start
 * reserves and siblings have something observably theirs to keep apart.
 */
let nextPort = 54_600;
const running = (): ResolveManagedStackRequest["configuration"] => ({
  lifecycle: "running",
  ports: [{ key: "api.port", port: nextPort++, intent: "exact" }],
});

const stoppedConfiguration: ResolveManagedStackRequest["configuration"] = {
  lifecycle: "stopped",
  runtimeMetadata: { processIds: {}, containerIds: {} },
};

describe.each(adapters)(
  "worktree and named-stack isolation fixtures with the %s adapter",
  (_name, make) => {
    const openService = async (root: string): Promise<ManagedStackServiceHandle> => {
      const service = await make(root);
      openHandles.push(service);
      return service;
    };

    it("shares one project across sibling linked worktrees while their checkouts stay apart", async () => {
      const scenario = fixture("identity.linked-worktrees-share-project-not-checkout");
      const bindings = symbolBindings(scenario.id);
      const call = resolveCall(scenario);
      const gitState = gitStateFact(scenario, call.cwd);
      const [first, second] = worktreePair(scenario);
      const branch = headBranch(scenario, call.cwd);

      const root = makeRoot();
      // Named as the fixture names the common directory, so the identity
      // locations it states can be checked as the paths they are.
      const repository = makeRepository(root, dirname(gitState.commonDirectory));
      nameInitialBranch(repository, branch);
      const workspaceA = join(root, first.path);
      const workspaceB = join(root, second.path);
      for (const workspace of [workspaceA, workspaceB]) {
        git(repository, "worktree", "add", "-q", "-f", workspace, branch);
      }
      const service = await openService(root);

      // Both worktrees are known checkouts before the call, which is what makes
      // the project they share observable without either stack existing yet.
      for (const [fact, workspace] of [
        [first, workspaceA],
        [second, workspaceB],
      ] as const) {
        const claim = await claimCheckout(workspace);
        const checkout = checkoutFact(scenario, fact.path);
        bindings.bind(checkout.projectId, claim.projectId);
        bindings.bind(checkout.checkoutId, claim.checkoutId);
      }
      const locations: WorkspaceLocations = {
        commonDirectory: join(root, gitState.commonDirectory),
        gitDirectory: join(root, gitState.gitDirectory),
        branch,
      };
      expectAbsentClaims(scenario, locations);

      const result = await service.resolveStack({
        workspacePath: workspaceB,
        operation: "start",
        stackName: call.stackName,
        configuration: running(),
      });

      expect(result.outcome).toBe(scenario.expected.outcome);
      bindSelection(bindings, scenario, result.selection);
      expect(result.workspace.checkoutKind).toBe(CHECKOUT_KIND_OF_MODE[second.mode]);
      expect(result.context).toEqual({ kind: "branch", branch });
      // The project identity lives in the shared repository, the checkout
      // identity in this worktree's own git directory.
      expect(result.workspace.projectIdentityLocation).toBe(locations.commonDirectory);
      expect(result.workspace.checkoutIdentityLocation).toBe(locations.gitDirectory);
      const witness = witnessOf(locations, result.stack);
      verifyWrites(bindings, scenario, witness);
      verifyRuntimeEffects(bindings, scenario, witness);
    });

    it("keeps one branch forced into two worktrees on one context and two stacks", async () => {
      const scenario = fixture("identity.same-branch-in-two-worktrees-is-isolated");
      const bindings = symbolBindings(scenario.id);
      const call = resolveCall(scenario);
      const gitState = gitStateFact(scenario, call.cwd);
      const [first, second] = worktreePair(scenario);
      const context = onlyBranchFact(scenario);
      const sibling = onlyStackFact(scenario);

      const root = makeRoot();
      const repository = makeRepository(root, dirname(gitState.commonDirectory));
      nameInitialBranch(repository, context.name);
      const workspaceA = join(root, first.path);
      const workspaceB = join(root, second.path);
      for (const workspace of [workspaceA, workspaceB]) {
        // Forced, because git will not check one branch out twice on its own —
        // and a workspace shape a user can only reach by forcing it is exactly
        // the one whose isolation is worth stating.
        git(repository, "worktree", "add", "-q", "-f", workspace, context.name);
      }
      const service = await openService(root);

      // The sibling stack the scenario starts from: worktree-a's own, in the
      // context both worktrees share.
      const existing = await service.resolveStack({
        workspacePath: workspaceA,
        operation: "start",
        stackName: sibling.name,
        configuration: running(),
      });
      const checkoutA = checkoutFact(scenario, first.path);
      bindings.bind(checkoutA.projectId, existing.identity.projectId);
      bindings.bind(checkoutA.checkoutId, existing.identity.checkoutId);
      bindings.bind(context.contextId, existing.identity.contextId);
      bindings.bind(sibling.stackId, existing.stack.id);
      expect(existing.stack.lifecycle).toBe(sibling.lifecycle);

      const claim = await claimCheckout(workspaceB);
      const checkoutB = checkoutFact(scenario, second.path);
      bindings.bind(checkoutB.projectId, claim.projectId);
      bindings.bind(checkoutB.checkoutId, claim.checkoutId);

      const result = await service.resolveStack({
        workspacePath: workspaceB,
        operation: "start",
        stackName: call.stackName,
        configuration: running(),
      });

      // Git owns the branch context, so both worktrees resolve the one context —
      // and the checkout is still part of the stack's identity, so neither
      // worktree can adopt the other's stack or the state under it.
      expect(result.outcome).toBe(scenario.expected.outcome);
      bindSelection(bindings, scenario, result.selection);
      expect(result.workspace.checkoutKind).toBe(CHECKOUT_KIND_OF_MODE[second.mode]);
      expect(result.stack.paths.root).not.toBe(existing.stack.paths.root);
      const locations: WorkspaceLocations = {
        commonDirectory: join(root, gitState.commonDirectory),
        gitDirectory: join(root, gitState.gitDirectory),
        branch: context.name,
      };
      expect(result.workspace.projectIdentityLocation).toBe(locations.commonDirectory);
      expect(result.workspace.checkoutIdentityLocation).toBe(locations.gitDirectory);
      verifyWrites(bindings, scenario, witnessOf(locations, result.stack));
    });

    it("shares a bare repository's project across its worktrees with no primary checkout", async () => {
      const scenario = fixture("identity.bare-repository-linked-worktrees-share-project");
      const bindings = symbolBindings(scenario.id);
      const call = resolveCall(scenario);
      const [first, second] = worktreePair(scenario);
      const context = onlyBranchFact(scenario);
      const sibling = onlyStackFact(scenario);
      const projectLocation = detailString(scenario, "project_identity_location");
      const checkoutLocation = detailString(scenario, "checkout_identity_location");

      const root = makeRoot();
      // Named as the fixture names the project identity location, so what the
      // resolution reports can be checked as a path. A bare repository has no
      // working tree, so its worktrees are the only checkouts in play.
      const bare = makeBareRepository(root, makeRepository(root, "origin"), projectLocation);
      const workspaceA = join(root, first.path);
      const workspaceB = join(root, second.path);
      for (const workspace of [workspaceA, workspaceB]) {
        git(bare, "worktree", "add", "-q", "-f", workspace, context.name);
      }
      const service = await openService(root);

      const existing = await service.resolveStack({
        workspacePath: workspaceA,
        operation: "start",
        stackName: sibling.name,
        configuration: running(),
      });
      const checkoutA = checkoutFact(scenario, first.path);
      bindings.bind(checkoutA.projectId, existing.identity.projectId);
      bindings.bind(checkoutA.checkoutId, existing.identity.checkoutId);
      bindings.bind(context.contextId, existing.identity.contextId);
      bindings.bind(sibling.stackId, existing.stack.id);

      const claim = await claimCheckout(workspaceB);
      const checkoutB = checkoutFact(scenario, second.path);
      bindings.bind(checkoutB.projectId, claim.projectId);
      bindings.bind(checkoutB.checkoutId, claim.checkoutId);

      const result = await service.resolveStack({
        workspacePath: workspaceB,
        operation: "start",
        stackName: call.stackName,
        configuration: running(),
      });

      expect(result.outcome).toBe(scenario.expected.outcome);
      bindSelection(bindings, scenario, result.selection);
      expect(result.workspace.checkoutKind).toBe(CHECKOUT_KIND_OF_MODE[second.mode]);
      // There is no primary worktree to fall back on, so the bare repository
      // directory itself is where the project identity lives.
      expect(result.workspace.projectIdentityLocation).toBe(join(root, projectLocation));
      expect(result.workspace.checkoutIdentityLocation).toBe(join(root, checkoutLocation));
      expect(storedConfigValue(gitConfigPath(bare), GIT_PROJECT_ID_KEY)).toBe(
        result.identity.projectId,
      );

      // `primaryWorktreeRequired: false`, as git itself reports it: the
      // repository is listed bare, and every working tree is one of the two
      // linked worktrees.
      const listed = git(bare, "worktree", "list", "--porcelain");
      expect([...listed.matchAll(/^worktree (?<path>.+)$/gm)].map(([, path]) => path)).toEqual([
        bare,
        workspaceA,
        workspaceB,
      ]);
      expect(listed).toMatch(/^bare$/m);

      verifyWrites(
        bindings,
        scenario,
        witnessOf(
          {
            commonDirectory: bare,
            gitDirectory: join(root, checkoutLocation),
            branch: context.name,
          },
          result.stack,
        ),
      );
    });

    it("scopes a named stack inside the branch context its checkout is already in", async () => {
      const scenario = fixture("identity.named-stacks-are-context-scoped");
      const bindings = symbolBindings(scenario.id);
      const call = resolveCall(scenario);
      const context = onlyBranchFact(scenario);
      const sibling = onlyStackFact(scenario);
      const checkout = checkoutFact(scenario, call.cwd);

      const root = makeRoot();
      const repository = makeRepository(root, checkout.path);
      git(repository, "checkout", "-q", "-b", context.name);
      const service = await openService(root);

      // The default stack this context already has.
      const existing = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: sibling.name,
        configuration: running(),
      });
      bindings.bind(checkout.projectId, existing.identity.projectId);
      bindings.bind(checkout.checkoutId, existing.identity.checkoutId);
      bindings.bind(context.contextId, existing.identity.contextId);
      bindings.bind(sibling.stackId, existing.stack.id);
      expect(existing.stack.lifecycle).toBe(sibling.lifecycle);

      const result = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: call.stackName,
        configuration: running(),
      });

      expect(result.outcome).toBe(scenario.expected.outcome);
      // Everything but the stack is shared, and the bindings are what say so:
      // the project, checkout, and context symbols were bound by the sibling,
      // and the new stack's symbol may not take a value any of them holds.
      bindSelection(bindings, scenario, result.selection);
      expect(result.stack.paths.root).not.toBe(existing.stack.paths.root);
      expect(result.stacks.map((stack) => stack.name).sort()).toEqual(
        [sibling.name, result.stackName].sort(),
      );
      verifyWrites(
        bindings,
        scenario,
        witnessOf(primaryLocations(repository, context.name), result.stack),
      );
    });

    it("gives a new branch its own context and stack on the first start", async () => {
      const scenario = fixture("identity.new-branch-first-start-creates-stack");
      const bindings = symbolBindings(scenario.id);
      const call = resolveCall(scenario);
      const gitState = gitStateFact(scenario, call.cwd);
      const checkout = checkoutFact(scenario, call.cwd);
      const started = checkedOutBranchFact(scenario);
      // The branch the checkout came from, which already has a context of its own.
      const previous = idleBranchFact(scenario);

      const root = makeRoot();
      const repository = makeRepository(root, checkout.path);
      nameInitialBranch(repository, previous.name);
      const service = await openService(root);

      const claim = await claimCheckout(repository);
      bindings.bind(checkout.projectId, claim.projectId);
      bindings.bind(checkout.checkoutId, claim.checkoutId);
      bindings.bind(previous.contextId, await claimBranchContext(repository, previous.name));
      git(repository, "checkout", "-q", "-b", started.name);
      expect(currentBranch(repository)).toBe(started.name);

      const result = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: call.stackName,
        configuration: running(),
      });

      expect(result.outcome).toBe(scenario.expected.outcome);
      // The new branch's context symbol is not the one the previous branch
      // holds, so the bindings refuse a context that was merely inherited.
      bindSelection(bindings, scenario, result.selection);
      expect(result.context).toEqual({ kind: "branch", branch: started.name });
      // A primary checkout's git directory *is* the repository, which is what
      // the fixture's identical common and git directories say.
      expect(gitState.gitDirectory).toBe(gitState.commonDirectory);
      expect(result.workspace.checkoutIdentityLocation).toBe(
        result.workspace.projectIdentityLocation,
      );
      verifyWrites(
        bindings,
        scenario,
        witnessOf(primaryLocations(repository, started.name), result.stack),
      );
    });

    it("reuses a branch's own stack when the branch comes back", async () => {
      const scenario = fixture("identity.return-to-branch-reuses-stack");
      const bindings = symbolBindings(scenario.id);
      const call = resolveCall(scenario);
      const checkout = checkoutFact(scenario, call.cwd);
      const context = onlyBranchFact(scenario);
      const existing = onlyStackFact(scenario);

      const root = makeRoot();
      const repository = makeRepository(root, checkout.path);
      nameInitialBranch(repository, context.name);
      const service = await openService(root);

      const configuration = running();
      const created = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: existing.name,
        configuration,
      });
      bindings.bind(checkout.projectId, created.identity.projectId);
      bindings.bind(checkout.checkoutId, created.identity.checkoutId);
      bindings.bind(context.contextId, created.identity.contextId);
      bindings.bind(existing.stackId, created.stack.id);

      // Away and back again, with the stack left as the scenario states it.
      await service.updateStack(created.stack.id, stoppedConfiguration);
      git(repository, "checkout", "-q", "-b", "elsewhere");
      git(repository, "checkout", "-q", context.name);
      expect((await service.inspectStack(created.stack.id))?.lifecycle).toBe(existing.lifecycle);

      const result = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: call.stackName,
        configuration,
      });

      expect(result.outcome).toBe(scenario.expected.outcome);
      bindSelection(bindings, scenario, result.selection);
      // Reuse publishes nothing: the returning start is the same stack, running
      // again on the ports it already held.
      expect(await service.listStacks()).toHaveLength(1);
      expect(result.stack.ports).toEqual(created.stack.ports);
      const witness = witnessOf(primaryLocations(repository, context.name), result.stack);
      verifyWrites(bindings, scenario, witness);
      verifyRuntimeEffects(bindings, scenario, witness);
    });

    it("reuses one detached context across the commits a checkout moves between", async () => {
      const scenario = fixture("identity.detached-commits-reuse-checkout-context");
      const bindings = symbolBindings(scenario.id);
      const call = resolveCall(scenario);
      const gitState = gitStateFact(scenario, call.cwd);
      const checkout = checkoutFact(scenario, call.cwd);
      const context = onlyBranchFact(scenario);
      const existing = onlyStackFact(scenario);
      const transition = transitionFact(scenario);
      if (transition.from === undefined || transition.to === undefined) {
        throw new Error(`${scenario.id} states no commits to move between`);
      }

      const root = makeRoot();
      const repository = makeRepository(root, checkout.path);
      bindings.bind(transition.from, git(repository, "rev-parse", "HEAD").trim());
      git(repository, "commit", "-q", "--allow-empty", "-m", "second");
      bindings.bind(transition.to, git(repository, "rev-parse", "HEAD").trim());
      git(repository, "checkout", "-q", bindings.valueOf(transition.from));
      const service = await openService(root);

      const configuration = running();
      const parked = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: existing.name,
        configuration,
      });
      bindings.bind(checkout.projectId, parked.identity.projectId);
      bindings.bind(checkout.checkoutId, parked.identity.checkoutId);
      bindings.bind(context.contextId, parked.identity.contextId);
      bindings.bind(existing.stackId, parked.stack.id);
      expect(parked.context).toEqual({
        kind: "detached",
        commit: bindings.valueOf(transition.from),
      });
      await service.updateStack(parked.stack.id, stoppedConfiguration);

      // A different commit in the same checkout is the same development
      // context: keying one per commit would strand a stack on every checkout.
      git(repository, "checkout", "-q", bindings.valueOf(transition.to));
      const result = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: call.stackName,
        configuration,
      });

      expect(result.outcome).toBe(scenario.expected.outcome);
      bindSelection(bindings, scenario, result.selection);
      expect(result.context).toEqual({
        kind: gitState.head,
        commit: bindings.valueOf(gitState.commit),
      });
      expect(await service.listStacks()).toHaveLength(1);
      verifyRuntimeEffects(
        bindings,
        scenario,
        witnessOf(primaryLocations(repository), result.stack),
      );
    });

    it("reports an unregistered checkout without writing anything", async () => {
      const scenario = fixture("identity.read-only-unregistered-checkout-does-not-write");
      const call = resolveCall(scenario);
      const [workspace] = workspaceFacts(scenario);
      if (workspace === undefined) {
        throw new Error(`${scenario.id} states no workspace`);
      }

      const root = makeRoot();
      const repository = makeRepository(root, workspace.path);
      const locations = primaryLocations(repository, currentBranch(repository));
      const service = await openService(root);
      expectAbsentClaims(scenario, locations);
      const before = await stateWitness(service, locations);

      const result = await service.resolveStack({
        workspacePath: repository,
        operation: call.operation,
        stackName: call.stackName,
      });

      expect(result.outcome).toBe(scenario.expected.outcome);
      // `registered: false` is an absent identity, not an absent classification:
      // a caller can report what the workspace is without any of it having been
      // claimed on its behalf.
      requireDetail(scenario, "registered", false);
      expect(result.state).toBe("unregistered");
      expect(result.identity).toEqual({});
      expect(result.stacks).toEqual([]);
      expect(result.selection).toBeUndefined();
      expect(result.identityMarkerCreated).toBe(scenario.expected.details?.identity_marker_created);
      expect(result.workspace.checkoutKind).toBe(CHECKOUT_KIND_OF_MODE[workspace.mode]);
      expect(result.workspace.projectIdentityLocation).toBe(locations.commonDirectory);

      expect(scenario.expected.writes).toEqual([]);
      expect(await stateWitness(service, locations)).toEqual(before);
    });

    it("refuses every invalid stack name before claiming or registering anything", async () => {
      const scenarios = managedStackContractFixtures.filter(({ id }) =>
        id.startsWith("identity.invalid-stack-name-"),
      );
      if (scenarios.length === 0) {
        throw new Error("The contract states no invalid stack names");
      }

      const root = makeRoot();
      const repository = makeRepository(root, "repo");
      const locations = primaryLocations(repository, currentBranch(repository));
      const service = await openService(root);
      const untouched = await stateWitness(service, locations);

      for (const scenario of scenarios) {
        if (scenario.expected.outcome !== "error") {
          throw new Error(`${scenario.id} does not expect an error`);
        }
        for (const stackName of stackNames(scenario)) {
          const rejection = await service
            .resolveStack({ workspacePath: repository, operation: "start", stackName })
            .then(
              () => undefined,
              (error: unknown) => error,
            );

          expect(rejection, `${scenario.id} must refuse ${stackName}`).toBeInstanceOf(
            InvalidManagedStackNameError,
          );
          expect(rejection).toMatchObject({ stackName });
          // Refused before anything was claimed: no project id, no checkout
          // marker, no branch context, no registry row, and no stack state.
          expect(scenario.expected.writes).toEqual([]);
          expect(await stateWitness(service, locations)).toEqual(untouched);
        }
      }
    });

    it("resolves every valid stack name to its own deterministic stack, writing nothing", async () => {
      const scenario = fixture("identity.valid-stack-names-resolve-deterministically");
      const bindings = symbolBindings(scenario.id);
      const when = scenario.when;
      if (when.interface !== "managed-api" || typeof when.input.cwd !== "string") {
        throw new Error(`${scenario.id} states no managed call on a workspace`);
      }
      const cwd = when.input.cwd;
      const checkout = checkoutFact(scenario, cwd);
      const context = onlyBranchFact(scenario);
      const names = stackNames(scenario);
      if (names.length < 2) {
        throw new Error(`${scenario.id} states fewer than two names to tell apart`);
      }
      /** The fixture's detail key for one name's stack, `review-42` included. */
      const stackSymbol = (name: string): string =>
        detailString(scenario, `${name.replaceAll("-", "_")}_stack_id`);

      const root = makeRoot();
      const repository = makeRepository(root, cwd);
      git(repository, "checkout", "-q", "-b", context.name);
      const locations = primaryLocations(repository, context.name);
      const service = await openService(root);

      for (const stackName of names) {
        const created = await service.resolveStack({
          workspacePath: repository,
          operation: "start",
          stackName,
          configuration: running(),
        });
        bindings.bind(checkout.projectId, created.identity.projectId);
        bindings.bind(checkout.checkoutId, created.identity.checkoutId);
        bindings.bind(context.contextId, created.identity.contextId);
        bindings.bind(stackSymbol(stackName), created.stack.id);
      }
      const before = await stateWitness(service, locations);

      // The read-only resolution the scenario asks for, twice: which stack a
      // name means is a function of the context it is asked in, so asking again
      // must not answer differently — or write anything on the way. The
      // scenario reports one resolution per name rather than one selection, so
      // its ids are bound through the facts and details that name them.
      for (const round of [1, 2]) {
        for (const stackName of names) {
          const reported = await service.resolveStack({
            workspacePath: repository,
            operation: "status",
            stackName,
          });

          expect(reported.outcome, `round ${round}`).toBe(scenario.expected.outcome);
          const selection = requireSelection(scenario, reported);
          expect(selection.stackName).toBe(stackName);
          bindings.bind(checkout.projectId, selection.projectId);
          bindings.bind(checkout.checkoutId, selection.checkoutId);
          bindings.bind(context.contextId, selection.contextId);
          bindings.bind(stackSymbol(stackName), selection.stackId);
        }
      }

      expect(scenario.expected.writes).toEqual([]);
      expect(await stateWitness(service, locations)).toEqual(before);
    });

    it("deletes an orphaned stack globally by its opaque id, and repeats as a no-op", async () => {
      const scenario = fixture("reclamation.delete-orphan-by-stack-id");
      const repeated = fixture("reclamation.delete-repeat-is-idempotent");
      const bindings = symbolBindings(scenario.id);
      const orphan = onlyStackFact(scenario);

      const root = makeRoot();
      const repository = makeRepository(root, "repo");
      const workspace = join(root, "worktree-orphan");
      git(repository, "worktree", "add", "-q", workspace, "-b", "feat/orphan");
      const service = await openService(root);

      const created = await service.resolveStack({
        workspacePath: workspace,
        operation: "start",
        stackName: orphan.name,
        configuration: running(),
      });
      bindings.bind(orphan.stackId, created.stack.id);
      expect(created.stack.lifecycle).toBe(orphan.lifecycle);
      expect(existsSync(created.stack.paths.data)).toBe(true);

      // Orphaned: the workspace is gone, so nothing can resolve this stack any
      // more and only its opaque id can reach it — which is all deletion takes,
      // from wherever the caller happens to be.
      if (orphan.orphaned !== true) {
        throw new Error(`${scenario.id} states no orphaned stack`);
      }
      requireDetail(scenario, "checkout_required", false);
      rmSync(workspace, { force: true, recursive: true });

      let stopped = false;
      const deleted = await service.deleteStack(created.stack.id, {
        stop: () => {
          stopped = true;
          return Promise.resolve();
        },
      });

      expect(deleted.outcome).toBe(scenario.expected.outcome);
      expect(deleted.dataReclamation).toEqual({ outcome: "removed" });
      requireDetail(scenario, "tombstoned", true);
      const tombstone = await service.inspectStack(created.stack.id);
      expect(await service.listStacks()).toEqual([]);
      const witness: ContractWitness = {
        ...primaryLocations(repository),
        stackId: created.stack.id,
        paths: created.stack.paths,
        lifecycle: tombstone?.lifecycle,
        status: tombstone?.status,
        stopped,
      };
      verifyWrites(bindings, scenario, witness);
      verifyRuntimeEffects(bindings, scenario, witness);

      // The tombstone is what makes the repeat a successful no-op rather than a
      // second deletion or a stack that cannot be found.
      const before = await service.listStacks({ includeTombstoned: true });
      const again = await service.deleteStack(created.stack.id);
      expect(again.outcome).toBe(repeated.expected.outcome);
      requireDetail(repeated, "idempotent", true);
      expect(repeated.expected.writes).toEqual([]);
      expect(await service.listStacks({ includeTombstoned: true })).toEqual(before);
    });

    it("leaves a stack's rows and data alone when only its git branch is deleted", async () => {
      const scenario = fixture("reclamation.branch-delete-does-not-delete-data");
      const bindings = symbolBindings(scenario.id);
      const current = checkedOutBranchFact(scenario);
      const abandoned = idleBranchFact(scenario);
      const checkout = checkoutFact(scenario, gitStateFact(scenario, "checkout-a").workspacePath);
      const orphaned = onlyStackFact(scenario);

      const root = makeRoot();
      const repository = makeRepository(root, checkout.path);
      nameInitialBranch(repository, current.name);
      const config = gitConfigPath(join(repository, ".git"));
      const service = await openService(root);

      git(repository, "checkout", "-q", "-b", abandoned.name);
      const created = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: orphaned.name,
        configuration: running(),
      });
      bindings.bind(checkout.projectId, created.identity.projectId);
      bindings.bind(checkout.checkoutId, created.identity.checkoutId);
      bindings.bind(abandoned.contextId, created.identity.contextId);
      bindings.bind(orphaned.stackId, created.stack.id);
      await service.updateStack(created.stack.id, stoppedConfiguration);
      git(repository, "checkout", "-q", current.name);
      bindings.bind(current.contextId, await claimBranchContext(repository, current.name));
      const before = await service.listStacks();

      // The scenario's whole action — and no managed command at all.
      requireDetail(scenario, "managed_command_ran", false);
      git(repository, "branch", "-D", abandoned.name);

      // Git takes the branch's own config section with it, so the context id
      // that reached this stack is gone and the stack is orphaned...
      requireDetail(scenario, "stack_orphaned", true);
      bindings.bind(detailString(scenario, "orphaned_stack_id"), created.stack.id);
      expect(storedConfigValue(config, gitBranchContextIdKey(abandoned.name))).toBeUndefined();
      // ...and orphaned is not deleted. Nothing about the branch's removal
      // reaches the registry or the mutable data underneath it.
      requireDetail(scenario, "stack_data_preserved", true);
      expect(scenario.expected.writes).toEqual([]);
      expect(await service.listStacks()).toEqual(before);
      expect((await service.inspectStack(created.stack.id))?.lifecycle).toBe(orphaned.lifecycle);
      expect(existsSync(created.stack.paths.data)).toBe(true);
      // The project, and the branch still in use, are untouched by it too.
      expect(storedConfigValue(config, GIT_PROJECT_ID_KEY)).toBe(created.identity.projectId);
      expect(storedConfigValue(config, gitBranchContextIdKey(current.name))).toBe(
        bindings.valueOf(current.contextId),
      );
    });

    /**
     * The end of CLI-2107, observed rather than argued: three stacks as close to
     * each other as the model allows — two sibling worktrees' defaults, plus a
     * second named stack inside the first worktree's context — each with its own
     * state directory and ports, and a global delete of one that the other two
     * cannot feel.
     */
    it("keeps three sibling stacks' state, ports, and data apart across a global delete", async () => {
      const root = makeRoot();
      const service = await openService(root);
      const repository = makeRepository(root, "repo");
      const worktree = join(root, "worktree-b");
      git(repository, "worktree", "add", "-q", worktree, "-b", "feat/b");

      const defaultA = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        configuration: running(),
      });
      const reviewA = await service.resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: "review",
        configuration: running(),
      });
      const defaultB = await service.resolveStack({
        workspacePath: worktree,
        operation: "start",
        configuration: running(),
      });
      const siblings = [defaultA, reviewA, defaultB];

      // One project, two checkouts, three stacks — each in its own
      // `stacks/<uuid>` directory, on ports of its own.
      expect(new Set(siblings.map(({ identity }) => identity.projectId)).size).toBe(1);
      expect(new Set(siblings.map(({ identity }) => identity.checkoutId)).size).toBe(2);
      expect(new Set(siblings.map(({ stack }) => stack.id)).size).toBe(3);
      const stacksRoot = join(service.stateRoot, "stacks");
      for (const { stack } of siblings) {
        expect(relative(stacksRoot, stack.paths.root)).toBe(stack.id);
        expect(existsSync(stack.paths.data)).toBe(true);
      }
      expect(
        new Set(siblings.flatMap(({ stack }) => stack.ports.map(({ port }) => port))).size,
      ).toBe(3);

      const survivors = [defaultA, defaultB];
      const before = await Promise.all(
        survivors.map(({ stack }) => service.inspectStack(stack.id)),
      );

      const deleted = await service.deleteStack(reviewA.stack.id, {
        stop: () => Promise.resolve(),
      });

      expect(deleted.outcome).toBe("delete");
      expect(existsSync(reviewA.stack.paths.root)).toBe(false);
      // Nothing the survivors own moved: same projections, same ports, same data.
      expect(
        await Promise.all(survivors.map(({ stack }) => service.inspectStack(stack.id))),
      ).toEqual(before);
      for (const { stack } of survivors) {
        expect(existsSync(stack.paths.data)).toBe(true);
      }
      expect((await service.listStacks()).map(({ id }) => id).sort()).toEqual(
        survivors.map(({ stack }) => stack.id).sort(),
      );
      // And each survivor still resolves through the identity it always did.
      for (const [workspace, survivor] of [
        [repository, defaultA],
        [worktree, defaultB],
      ] as const) {
        const reported = await service.resolveStack({
          workspacePath: workspace,
          operation: "status",
        });
        expect(reported.selection?.stackId).toBe(survivor.stack.id);
        expect(reported.identity.projectId).toBe(defaultA.identity.projectId);
      }
    });
  },
);
