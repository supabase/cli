import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStack } from "./node.ts";
import {
  managedNativeServiceMatrix,
  managedStackContractFixtures,
  type ManagedStackContractFact,
  type ManagedStackContractScenario,
  validateManagedStackContractFixtures,
} from "./testing.ts";

describe("managed stack acceptance contract", () => {
  it("keeps every shared scenario readable and executable through a public interface", () => {
    expect(validateManagedStackContractFixtures(managedStackContractFixtures)).toEqual([]);
  });

  it("rejects contract edits that make IDs, effects, and projections disagree", () => {
    const scenario: ManagedStackContractScenario | undefined = managedStackContractFixtures.find(
      ({ id }) => id === "identity.return-to-branch-reuses-stack",
    );
    if (scenario === undefined) {
      throw new Error("identity.return-to-branch-reuses-stack fixture is required");
    }
    if (
      scenario.expected.selection === undefined ||
      scenario.expected.output.human === undefined ||
      scenario.expected.output.json === undefined
    ) {
      throw new Error("identity.return-to-branch-reuses-stack must select and project a stack");
    }

    const missingStartWrite = {
      ...scenario,
      expected: { ...scenario.expected, writes: [] },
    };
    expect(validateManagedStackContractFixtures([missingStartWrite])).toContain(
      `${scenario.id}: start runtime effect requires a matching state write`,
    );

    const undeclaredSelection = {
      ...scenario,
      expected: {
        ...scenario.expected,
        selection: { ...scenario.expected.selection, stackId: "stack-undeclared" },
      },
    };
    expect(validateManagedStackContractFixtures([undeclaredSelection])).toContain(
      `${scenario.id}: selection references undeclared ID stack-undeclared`,
    );

    const independentBranchesScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "identity.same-commit-different-branches-are-independent",
      );
    if (
      independentBranchesScenario === undefined ||
      independentBranchesScenario.expected.selection === undefined
    ) {
      throw new Error(
        "identity.same-commit-different-branches-are-independent selection is required",
      );
    }
    const selectionWithWrongContext = {
      ...independentBranchesScenario,
      expected: {
        ...independentBranchesScenario.expected,
        selection: {
          ...independentBranchesScenario.expected.selection,
          contextId: "context-main",
        },
        output: {
          ...independentBranchesScenario.expected.output,
          api: {
            ...independentBranchesScenario.expected.output.api,
            contextId: "context-main",
          },
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([selectionWithWrongContext])).toContain(
      `${independentBranchesScenario.id}: selected stack stack-feat-default belongs to context context-feat, not context-main`,
    );

    const selectionWithWrongName = {
      ...independentBranchesScenario,
      expected: {
        ...independentBranchesScenario.expected,
        selection: {
          ...independentBranchesScenario.expected.selection,
          stackName: "review",
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([selectionWithWrongName])).toContain(
      `${independentBranchesScenario.id}: selected stack stack-feat-default is named default, not review`,
    );

    const undeclaredWrite = {
      ...scenario,
      expected: {
        ...scenario.expected,
        writes: [{ target: "runtime-state", operation: "start", id: "stack-undeclared" }],
        runtimeEffects: [{ operation: "start", stackId: "stack-undeclared" }],
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([undeclaredWrite])).toContain(
      `${scenario.id}: runtime-state start references undeclared ID stack-undeclared`,
    );

    const divergentProjection = {
      ...scenario,
      expected: {
        ...scenario.expected,
        output: {
          ...scenario.expected.output,
          json: { ...scenario.expected.output.json, outcome: "create" },
        },
      },
    };
    expect(validateManagedStackContractFixtures([divergentProjection])).toContain(
      `${scenario.id}: projected outcome disagrees with the managed result`,
    );

    const divergentHumanProjection = {
      ...scenario,
      expected: {
        ...scenario.expected,
        output: {
          ...scenario.expected.output,
          human: {
            ...scenario.expected.output.human,
            fields: { ...scenario.expected.output.human.fields, stackId: "stack-other" },
          },
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([divergentHumanProjection])).toContain(
      `${scenario.id}: projected stackId disagrees with the managed result`,
    );

    const existingTarget: ManagedStackContractFact = {
      kind: "managed-target",
      stackId: "stack-main-default",
      exists: true,
    };
    const ambiguousExistingStart = {
      ...scenario,
      given: [...scenario.given.filter(({ kind }) => kind !== "stack"), existingTarget],
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([ambiguousExistingStart])).toContain(
      `${scenario.id}: starting existing stack stack-main-default requires an explicit stopped lifecycle`,
    );

    const trackedMarkerScenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.fresh-clone-ignores-tracked-marker",
    );
    if (trackedMarkerScenario === undefined) {
      throw new Error("identity.fresh-clone-ignores-tracked-marker fixture is required");
    }
    const identityMarkerWrite = {
      target: "identity-marker",
      operation: "create",
      id: "marker-project-a",
      storage: "project-local-untracked",
      projectId: "project-a",
      checkoutId: "checkout-a",
      contextId: "context-main",
    } satisfies ManagedStackContractScenario["expected"]["writes"][number];
    const trackedMarkerMutation = {
      ...trackedMarkerScenario,
      expected: {
        ...trackedMarkerScenario.expected,
        writes: [...trackedMarkerScenario.expected.writes, identityMarkerWrite],
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([trackedMarkerMutation])).toContain(
      `${trackedMarkerScenario.id}: a tracked identity marker must remain untouched`,
    );

    const gitWorkspaceScenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.fresh-clone-creates-project-and-checkout",
    );
    if (gitWorkspaceScenario === undefined) {
      throw new Error("identity.fresh-clone-creates-project-and-checkout fixture is required");
    }
    const gitWorkspaceMarkerMutation = {
      ...gitWorkspaceScenario,
      expected: {
        ...gitWorkspaceScenario.expected,
        writes: [...gitWorkspaceScenario.expected.writes, identityMarkerWrite],
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([gitWorkspaceMarkerMutation])).toContain(
      `${gitWorkspaceScenario.id}: Git workspace identity must use Git-local metadata`,
    );

    const absentLegacyScenario = managedStackContractFixtures.find(
      ({ id }) => id === "bootstrap.absent-legacy-starts-fresh",
    );
    if (absentLegacyScenario === undefined) {
      throw new Error("bootstrap.absent-legacy-starts-fresh fixture is required");
    }
    const unpublishedManagedState = {
      ...absentLegacyScenario,
      expected: {
        ...absentLegacyScenario.expected,
        writes: absentLegacyScenario.expected.writes.filter(({ target }) => target !== "registry"),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([unpublishedManagedState])).toContain(
      `${absentLegacyScenario.id}: managed-state create requires registry publication`,
    );

    const publishedWithoutState = {
      ...absentLegacyScenario,
      expected: {
        ...absentLegacyScenario.expected,
        writes: absentLegacyScenario.expected.writes.filter(
          ({ target }) => target !== "managed-state",
        ),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([publishedWithoutState])).toContain(
      `${absentLegacyScenario.id}: registry publication requires managed-state creation or copy`,
    );

    const targetlessStateWrites = {
      ...absentLegacyScenario,
      expected: {
        ...absentLegacyScenario.expected,
        writes: absentLegacyScenario.expected.writes.map((write) =>
          write.target === "managed-state" || write.target === "registry"
            ? { ...write, id: "" }
            : write,
        ),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([targetlessStateWrites])).toContain(
      `${absentLegacyScenario.id}: managed-state write requires a target ID`,
    );

    const targetlessRuntimeEffect = {
      ...absentLegacyScenario,
      expected: {
        ...absentLegacyScenario.expected,
        runtimeEffects: absentLegacyScenario.expected.runtimeEffects.map((effect) => ({
          ...effect,
          stackId: "",
        })),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([targetlessRuntimeEffect])).toContain(
      `${absentLegacyScenario.id}: start runtime effect requires a stack ID`,
    );

    const stoppedStackScenario = managedStackContractFixtures.find(
      ({ id }) => id === "reclamation.default-stop-preserves-data",
    );
    if (stoppedStackScenario === undefined) {
      throw new Error("reclamation.default-stop-preserves-data fixture is required");
    }
    const missingStopEffect = {
      ...stoppedStackScenario,
      expected: { ...stoppedStackScenario.expected, runtimeEffects: [] },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([missingStopEffect])).toContain(
      `${stoppedStackScenario.id}: runtime-state update requires a matching runtime effect`,
    );

    const folderToGitScenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.folder-to-git-exact-claim-preserves-identity",
    );
    if (folderToGitScenario === undefined) {
      throw new Error("identity.folder-to-git-exact-claim-preserves-identity fixture is required");
    }
    const incompleteGitIdentity = {
      ...folderToGitScenario,
      expected: {
        ...folderToGitScenario.expected,
        writes: folderToGitScenario.expected.writes.filter(({ id }) => id !== "project-a"),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([incompleteGitIdentity])).toContain(
      `${folderToGitScenario.id}: folder-to-Git identity project-a must be persisted in Git-local metadata`,
    );

    const incorrectlyScopedGitIdentity = {
      ...folderToGitScenario,
      expected: {
        ...folderToGitScenario.expected,
        writes: folderToGitScenario.expected.writes.map((write) =>
          write.target === "git-config" && write.id === "project-a"
            ? { ...write, scope: "worktree" }
            : write,
        ),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([incorrectlyScopedGitIdentity])).toContain(
      `${folderToGitScenario.id}: Git identity project-a must use common config scope`,
    );

    const qualificationScenario = managedStackContractFixtures.find(
      ({ id }) => id === "native-qualification.all-services-qualify-platform",
    );
    if (qualificationScenario === undefined) {
      throw new Error("native-qualification.all-services-qualify-platform fixture is required");
    }
    const incompleteQualification = {
      ...qualificationScenario,
      given: qualificationScenario.given.map((fact) =>
        fact.kind === "native-qualification"
          ? { ...fact, qualifiedServices: fact.qualifiedServices.slice(1) }
          : fact,
      ),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([incompleteQualification])).toContain(
      `${qualificationScenario.id}: native qualification omits service postgres`,
    );

    const qualificationForDifferentPlatform = {
      ...qualificationScenario,
      given: qualificationScenario.given.map((fact) =>
        fact.kind === "native-qualification" ? { ...fact, platform: "linux-amd64" } : fact,
      ),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([qualificationForDifferentPlatform])).toContain(
      `${qualificationScenario.id}: native qualification platform must match the preflight action`,
    );

    const qualificationForUnknownPlatform = {
      ...qualificationScenario,
      given: qualificationScenario.given.map((fact) =>
        fact.kind === "native-qualification" ? { ...fact, platform: "solaris-sparc" } : fact,
      ),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([qualificationForUnknownPlatform])).toContain(
      `${qualificationScenario.id}: native qualification uses unknown platform solaris-sparc`,
    );

    const statusScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "identity.symlink-alias-reuses-checkout",
      );
    if (statusScenario === undefined || statusScenario.expected.output.json === undefined) {
      throw new Error("identity.symlink-alias-reuses-checkout JSON fixture is required");
    }
    const mutatingStatus = {
      ...statusScenario,
      expected: {
        ...statusScenario.expected,
        outcome: "reuse",
        output: {
          ...statusScenario.expected.output,
          json: { ...statusScenario.expected.output.json, outcome: "reuse" },
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([mutatingStatus])).toContain(
      `${statusScenario.id}: successful status operations must report`,
    );

    const stateWritingStatus = {
      ...statusScenario,
      expected: {
        ...statusScenario.expected,
        writes: [{ target: "registry", operation: "update", id: "checkout-a" }],
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([stateWritingStatus])).toContain(
      `${statusScenario.id}: status operations must not mutate state`,
    );

    const apiStatusScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "identity.same-checkout-branch-and-name-reuses-stack",
      );
    if (apiStatusScenario === undefined || apiStatusScenario.expected.output.api === undefined) {
      throw new Error(
        "identity.same-checkout-branch-and-name-reuses-stack API fixture is required",
      );
    }
    const apiStatusReturningReuse = {
      ...apiStatusScenario,
      expected: {
        ...apiStatusScenario.expected,
        outcome: "reuse",
        output: {
          ...apiStatusScenario.expected.output,
          api: { ...apiStatusScenario.expected.output.api, outcome: "reuse" },
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([apiStatusReturningReuse])).toContain(
      `${apiStatusScenario.id}: successful status operations must report`,
    );

    const bareWorktreeScenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.bare-repository-linked-worktrees-share-project",
    );
    if (bareWorktreeScenario === undefined) {
      throw new Error(
        "identity.bare-repository-linked-worktrees-share-project fixture is required",
      );
    }
    const siblingGitStateOnly = {
      ...bareWorktreeScenario,
      given: bareWorktreeScenario.given.map((fact) =>
        fact.kind === "git-state" ? { ...fact, workspacePath: "worktree-a" } : fact,
      ),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([siblingGitStateOnly])).toContain(
      `${bareWorktreeScenario.id}: resolving worktree worktree-b requires its Git state`,
    );

    const recreatedCheckoutIdentity = {
      ...bareWorktreeScenario,
      expected: {
        ...bareWorktreeScenario.expected,
        writes: [
          ...bareWorktreeScenario.expected.writes,
          {
            target: "git-config",
            operation: "create",
            id: "checkout-b",
            scope: "worktree",
          },
        ],
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([recreatedCheckoutIdentity])).toContain(
      `${bareWorktreeScenario.id}: Git identity checkout-b is already declared`,
    );

    const unavailableRuntimeScenario = managedStackContractFixtures.find(
      ({ id }) => id === "runtime.missing-persisted-prerequisite-fails",
    );
    if (unavailableRuntimeScenario === undefined) {
      throw new Error("runtime.missing-persisted-prerequisite-fails fixture is required");
    }
    const ambiguousRuntimeFailure = {
      ...unavailableRuntimeScenario,
      given: unavailableRuntimeScenario.given.filter(({ kind }) => kind !== "stack"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([ambiguousRuntimeFailure])).toContain(
      `${unavailableRuntimeScenario.id}: persisted runtime failure for stack-main-default requires an explicit stopped lifecycle`,
    );

    const portabilityScenario = managedStackContractFixtures.find(
      ({ id }) => id === "api-boundary.managed-surface-is-node-and-bun-portable",
    );
    if (portabilityScenario === undefined) {
      throw new Error("api-boundary.managed-surface-is-node-and-bun-portable fixture is required");
    }
    const divergentPortableResult = {
      ...portabilityScenario,
      expected: {
        ...portabilityScenario.expected,
        output: {
          ...portabilityScenario.expected.output,
          api: {
            node: { outcome: "reuse", stackId: "stack-main-default" },
            bun: { outcome: "report", stackId: "stack-main-default" },
            equal: true,
          },
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(
      validateManagedStackContractFixtures([apiStatusScenario, divergentPortableResult]),
    ).toContain(
      `${portabilityScenario.id}: portable node outcome must match ${apiStatusScenario.id}`,
    );

    const divergentPortableIdentity = {
      ...portabilityScenario,
      expected: {
        ...portabilityScenario.expected,
        output: {
          ...portabilityScenario.expected.output,
          api: {
            node: { outcome: "report", stackId: "stack-main-default" },
            bun: { outcome: "report", stackId: "stack-other" },
            equal: true,
          },
        },
      },
    } satisfies ManagedStackContractScenario;
    const divergentPortableIdentityErrors = validateManagedStackContractFixtures([
      apiStatusScenario,
      divergentPortableIdentity,
    ]);
    expect(divergentPortableIdentityErrors).toContain(
      `${portabilityScenario.id}: portable bun stackId must match ${apiStatusScenario.id}`,
    );
    expect(divergentPortableIdentityErrors).toContain(
      `${portabilityScenario.id}: portable runtime decisions must be identical`,
    );

    const siblingPortScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "ports.explicit-port-conflict-with-sibling-fails",
      );
    if (siblingPortScenario?.expected.selection === undefined) {
      throw new Error("ports.explicit-port-conflict-with-sibling-fails selection is required");
    }
    const targetOwnsConflictingPort = {
      ...siblingPortScenario,
      expected: {
        ...siblingPortScenario.expected,
        selection: {
          ...siblingPortScenario.expected.selection,
          stackId: "stack-main-default",
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([targetOwnsConflictingPort])).toContain(
      `${siblingPortScenario.id}: managed sibling port owner must differ from the selected target`,
    );

    const siblingAllocationScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "ports.sibling-targets-allocate-independent-ports",
      );
    if (
      siblingAllocationScenario === undefined ||
      siblingAllocationScenario.expected.output.api === undefined
    ) {
      throw new Error("ports.sibling-targets-allocate-independent-ports API fixture is required");
    }
    const siblingAllocationCollision = {
      ...siblingAllocationScenario,
      expected: {
        ...siblingAllocationScenario.expected,
        output: {
          ...siblingAllocationScenario.expected.output,
          api: {
            ...siblingAllocationScenario.expected.output.api,
            ports: { api: 55421, db: 55424 },
          },
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([siblingAllocationCollision])).toContain(
      `${siblingAllocationScenario.id}: allocated port 55421 conflicts with a sibling target`,
    );

    const stickyPortScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "ports.later-sticky-port-collision-fails",
      );
    if (stickyPortScenario === undefined) {
      throw new Error("ports.later-sticky-port-collision-fails fixture is required");
    }
    const stickyPortWithoutStoppedTarget = {
      ...stickyPortScenario,
      given: stickyPortScenario.given.filter(({ kind }) => kind !== "stack"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([stickyPortWithoutStoppedTarget])).toContain(
      `${stickyPortScenario.id}: sticky port conflict requires a stopped selected stack`,
    );

    const portUpdateScenario = managedStackContractFixtures.find(
      ({ id }) => id === "ports.config-change-on-stopped-stack-applies",
    );
    if (portUpdateScenario === undefined) {
      throw new Error("ports.config-change-on-stopped-stack-applies fixture is required");
    }
    const unboundPortUpdate = {
      ...portUpdateScenario,
      expected: { ...portUpdateScenario.expected, selection: undefined },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([unboundPortUpdate])).toContain(
      `${portUpdateScenario.id}: contextual CLI stack result requires a selected target`,
    );

    const runtimeConflictScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "runtime.persisted-runtime-conflict-fails",
      );
    if (runtimeConflictScenario === undefined) {
      throw new Error("runtime.persisted-runtime-conflict-fails fixture is required");
    }
    const unrelatedPersistedRuntime = {
      ...runtimeConflictScenario,
      given: runtimeConflictScenario.given.map((fact) =>
        fact.kind === "persisted-runtime" ? { ...fact, stackId: "stack-other" } : fact,
      ),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([unrelatedPersistedRuntime])).toContain(
      `${runtimeConflictScenario.id}: persisted runtime must belong to the selected target`,
    );

    const freshCloneScenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.fresh-clone-creates-project-and-checkout",
    );
    if (freshCloneScenario === undefined) {
      throw new Error("identity.fresh-clone-creates-project-and-checkout fixture is required");
    }
    const cloneWithoutGitState = {
      ...freshCloneScenario,
      given: freshCloneScenario.given.filter(({ kind }) => kind !== "git-state"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([cloneWithoutGitState])).toContain(
      `${freshCloneScenario.id}: creating a Git context requires Git state for the workspace`,
    );

    const refReplacementScenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.manual-ref-replacement-orphans-context",
    );
    if (refReplacementScenario === undefined) {
      throw new Error("identity.manual-ref-replacement-orphans-context fixture is required");
    }
    const refReplacementWithoutGitState = {
      ...refReplacementScenario,
      given: refReplacementScenario.given.filter((fact) => fact.kind !== "git-state"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([refReplacementWithoutGitState])).toContain(
      `${refReplacementScenario.id}: creating a Git context requires Git state for the workspace`,
    );

    const detachedCommitScenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.detached-commits-reuse-checkout-context",
    );
    if (detachedCommitScenario === undefined) {
      throw new Error("identity.detached-commits-reuse-checkout-context fixture is required");
    }
    const detachedReuseWithoutTransition = {
      ...detachedCommitScenario,
      given: detachedCommitScenario.given.filter(
        (fact) => fact.kind !== "identity-transition" || fact.operation !== "detached-commit",
      ),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([detachedReuseWithoutTransition])).toContain(
      `${detachedCommitScenario.id}: detached reuse must declare the commit transition`,
    );

    const retryScenario = managedStackContractFixtures.find(
      ({ id }) => id === "bootstrap.retry-after-failed-copy-succeeds",
    );
    if (retryScenario === undefined) {
      throw new Error("bootstrap.retry-after-failed-copy-succeeds fixture is required");
    }
    const retryWithoutRollback = {
      ...retryScenario,
      given: retryScenario.given.filter(({ kind }) => kind !== "operation-result"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([retryWithoutRollback])).toContain(
      `${retryScenario.id}: bootstrap retry requires a rolled-back prior attempt`,
    );

    for (const scenarioId of [
      "credentials.configured-values-are-authoritative",
      "credentials.explicit-change-applies-after-stop",
      "credentials.omitted-values-use-stable-defaults",
      "credentials.compatible-legacy-auth-is-retained",
    ]) {
      const credentialPersistenceScenario: ManagedStackContractScenario | undefined =
        managedStackContractFixtures.find(({ id }) => id === scenarioId);
      if (credentialPersistenceScenario === undefined) {
        throw new Error(`${scenarioId} fixture is required`);
      }
      const globallyPersistedPlaintext = {
        ...credentialPersistenceScenario,
        expected: {
          ...credentialPersistenceScenario.expected,
          details: {
            ...credentialPersistenceScenario.expected.details,
            plaintext_secrets_in_global_state: true,
          },
        },
      } satisfies ManagedStackContractScenario;
      expect(validateManagedStackContractFixtures([globallyPersistedPlaintext])).toContain(
        `${credentialPersistenceScenario.id}: credential persistence must not expose plaintext globally`,
      );
    }

    const pruneScenario = managedStackContractFixtures.find(
      ({ id }) => id === "reclamation.prune-removes-metadata-only",
    );
    if (pruneScenario === undefined) {
      throw new Error("reclamation.prune-removes-metadata-only fixture is required");
    }
    const pruneWithoutMutableData = {
      ...pruneScenario,
      given: pruneScenario.given.filter(({ kind }) => kind !== "stack"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([pruneWithoutMutableData])).toContain(
      `${pruneScenario.id}: data-preserving prune must declare mutable stack data`,
    );

    const deleteScenario = managedStackContractFixtures.find(
      ({ id }) => id === "reclamation.delete-orphan-by-stack-id",
    );
    if (deleteScenario === undefined) {
      throw new Error("reclamation.delete-orphan-by-stack-id fixture is required");
    }
    const runtimeMetadataOnlyDelete = {
      ...deleteScenario,
      expected: {
        ...deleteScenario.expected,
        writes: deleteScenario.expected.writes.filter((write) => write.target !== "managed-state"),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([runtimeMetadataOnlyDelete])).toContain(
      `${deleteScenario.id}: delete runtime effect requires a matching state write`,
    );

    const deleteWithoutStop = {
      ...deleteScenario,
      expected: {
        ...deleteScenario.expected,
        runtimeEffects: deleteScenario.expected.runtimeEffects.filter(
          ({ operation }) => operation !== "stop",
        ),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([deleteWithoutStop])).toContain(
      `${deleteScenario.id}: runtime-state delete requires a matching runtime effect`,
    );

    const deleteWithoutTombstone = {
      ...deleteScenario,
      expected: {
        ...deleteScenario.expected,
        writes: deleteScenario.expected.writes.filter(
          (write) => write.target !== "registry" || write.operation !== "tombstone",
        ),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([deleteWithoutTombstone])).toContain(
      `${deleteScenario.id}: managed-state deletion requires a registry tombstone`,
    );

    const stickyReuseScenario = managedStackContractFixtures.find(
      ({ id }) => id === "ports.sticky-ports-reuse-on-return",
    );
    if (stickyReuseScenario === undefined) {
      throw new Error("ports.sticky-ports-reuse-on-return fixture is required");
    }
    const unboundStickyReuse = {
      ...stickyReuseScenario,
      expected: { ...stickyReuseScenario.expected, selection: undefined },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([unboundStickyReuse])).toContain(
      `${stickyReuseScenario.id}: sticky port reuse requires a selected target`,
    );

    const repositoryContractScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "api-boundary.repository-contract-is-storage-agnostic",
      );
    if (
      repositoryContractScenario === undefined ||
      repositoryContractScenario.when.interface !== "managed-api"
    ) {
      throw new Error("api-boundary.repository-contract-is-storage-agnostic fixture is required");
    }
    const repositoryApiOutput = repositoryContractScenario.expected.output.api;
    if (repositoryApiOutput === undefined) {
      throw new Error("repository contract API output is required");
    }
    const emptyRepositoryMatrix = {
      ...repositoryContractScenario,
      when: {
        ...repositoryContractScenario.when,
        input: { ...repositoryContractScenario.when.input, adapters: [] },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([scenario, emptyRepositoryMatrix])).toContain(
      `${repositoryContractScenario.id}: repository contract must declare its adapters`,
    );

    const duplicateRepositoryMatrix = {
      ...repositoryContractScenario,
      when: {
        ...repositoryContractScenario.when,
        input: {
          ...repositoryContractScenario.when.input,
          adapters: ["in-memory", "in-memory"],
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([scenario, duplicateRepositoryMatrix])).toContain(
      `${repositoryContractScenario.id}: repository contract adapters must be unique`,
    );

    const repositoryMatrixMissingFact = {
      ...repositoryContractScenario,
      when: {
        ...repositoryContractScenario.when,
        input: { ...repositoryContractScenario.when.input, adapters: ["in-memory"] },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([scenario, repositoryMatrixMissingFact])).toContain(
      `${repositoryContractScenario.id}: repository adapters must match declared repository facts`,
    );

    const unknownRepositoryReference = {
      ...repositoryContractScenario,
      when: {
        ...repositoryContractScenario.when,
        input: { ...repositoryContractScenario.when.input, scenarioId: "identity.unknown" },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([unknownRepositoryReference])).toContain(
      `${repositoryContractScenario.id}: repository contract must reference a declared scenario`,
    );

    const staleRepositoryOutcome = {
      ...repositoryContractScenario,
      expected: {
        ...repositoryContractScenario.expected,
        output: {
          ...repositoryContractScenario.expected.output,
          api: {
            ...repositoryApiOutput,
            "in-memory": { outcome: "create", stackId: "stack-main-default" },
          },
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([scenario, staleRepositoryOutcome])).toContain(
      `${repositoryContractScenario.id}: repository in-memory outcome must match ${scenario.id}`,
    );

    const divergentRepositoryIdentity = {
      ...repositoryContractScenario,
      expected: {
        ...repositoryContractScenario.expected,
        output: {
          ...repositoryContractScenario.expected.output,
          api: {
            ...repositoryApiOutput,
            "persistent-adapter": { outcome: "reuse", stackId: "stack-other" },
          },
        },
      },
    } satisfies ManagedStackContractScenario;
    const divergentRepositoryErrors = validateManagedStackContractFixtures([
      scenario,
      divergentRepositoryIdentity,
    ]);
    expect(divergentRepositoryErrors).toContain(
      `${repositoryContractScenario.id}: repository persistent-adapter stackId must match ${scenario.id}`,
    );
    expect(divergentRepositoryErrors).toContain(
      `${repositoryContractScenario.id}: repository adapter decisions must be identical`,
    );

    const invalidNameScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "identity.invalid-stack-name-uppercase-underscore-fails",
      );
    const invalidNameHumanOutput = invalidNameScenario?.expected.output.human;
    if (invalidNameScenario === undefined || invalidNameHumanOutput === undefined) {
      throw new Error("invalid stack name fixture with human recovery is required");
    }
    const divergentHumanRecovery = {
      ...invalidNameScenario,
      expected: {
        ...invalidNameScenario.expected,
        output: {
          ...invalidNameScenario.expected.output,
          human: { ...invalidNameHumanOutput, recovery: ["Try again"] },
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([divergentHumanRecovery])).toContain(
      `${invalidNameScenario.id}: human recovery disagrees with the managed result`,
    );

    const divergentJsonRecovery = {
      ...invalidNameScenario,
      expected: {
        ...invalidNameScenario.expected,
        output: {
          ...invalidNameScenario.expected.output,
          json: { ...invalidNameScenario.expected.output.json, recovery: ["Try again"] },
        },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([divergentJsonRecovery])).toContain(
      `${invalidNameScenario.id}: JSON recovery disagrees with the managed result`,
    );

    const invalidNameJson = invalidNameScenario.expected.output.json;
    if (invalidNameJson === undefined) {
      throw new Error("invalid stack name JSON fixture is required");
    }
    const { code: omittedCode, ...jsonWithoutCode } = invalidNameJson;
    expect(omittedCode).toBe("invalid_stack_name");
    const jsonProjectionWithoutCode = {
      ...invalidNameScenario,
      expected: {
        ...invalidNameScenario.expected,
        output: { ...invalidNameScenario.expected.output, json: jsonWithoutCode },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([jsonProjectionWithoutCode])).toContain(
      `${invalidNameScenario.id}: JSON projection requires a code`,
    );

    const credentialDefaultsScenario: ManagedStackContractScenario | undefined =
      managedStackContractFixtures.find(
        ({ id }) => id === "credentials.omitted-values-use-stable-defaults",
      );
    const credentialDefaultsJson = credentialDefaultsScenario?.expected.output.json;
    if (credentialDefaultsScenario === undefined || credentialDefaultsJson === undefined) {
      throw new Error("credentials.omitted-values-use-stable-defaults JSON fixture is required");
    }
    const { outcome: omittedOutcome, ...jsonWithoutOutcome } = credentialDefaultsJson;
    expect(omittedOutcome).toBe("create");
    const credentialProjectionWithoutOutcome = {
      ...credentialDefaultsScenario,
      expected: {
        ...credentialDefaultsScenario.expected,
        output: { ...credentialDefaultsScenario.expected.output, json: jsonWithoutOutcome },
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([credentialProjectionWithoutOutcome])).toContain(
      `${credentialDefaultsScenario.id}: JSON projection requires an outcome`,
    );

    const newBranchScenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.new-branch-first-start-creates-stack",
    );
    if (newBranchScenario === undefined) {
      throw new Error("identity.new-branch-first-start-creates-stack fixture is required");
    }
    const contextOwnedByDifferentBranch = {
      ...newBranchScenario,
      expected: {
        ...newBranchScenario.expected,
        writes: newBranchScenario.expected.writes.map((write) =>
          write.target === "git-config" && write.id === "context-feat-a"
            ? { ...write, owner: "main" }
            : write,
        ),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([contextOwnedByDifferentBranch])).toContain(
      `${newBranchScenario.id}: Git context context-feat-a must belong to branch feat-a`,
    );

    const recreatedBranchScenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.branch-delete-recreate-creates-context",
    );
    if (recreatedBranchScenario === undefined) {
      throw new Error("identity.branch-delete-recreate-creates-context fixture is required");
    }
    const recreatedBranchWithoutGitState = {
      ...recreatedBranchScenario,
      given: recreatedBranchScenario.given.filter((fact) => fact.kind !== "git-state"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([recreatedBranchWithoutGitState])).toContain(
      `${recreatedBranchScenario.id}: creating a Git context requires Git state for the workspace`,
    );

    const firstOrdinaryFolderStart = managedStackContractFixtures.find(
      ({ id }) => id === "identity.non-git-folder-first-start-persists-identity",
    );
    if (firstOrdinaryFolderStart === undefined) {
      throw new Error("identity.non-git-folder-first-start-persists-identity fixture is required");
    }
    const ordinaryFolderWithoutMarkerWrite = {
      ...firstOrdinaryFolderStart,
      expected: {
        ...firstOrdinaryFolderStart.expected,
        writes: firstOrdinaryFolderStart.expected.writes.filter(
          (write) => write.target !== "identity-marker",
        ),
      },
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([ordinaryFolderWithoutMarkerWrite])).toContain(
      `${firstOrdinaryFolderStart.id}: ordinary-folder creation must persist its identity marker`,
    );

    const laterOrdinaryFolderStart = managedStackContractFixtures.find(
      ({ id }) => id === "identity.non-git-folder-recovers-persisted-identity",
    );
    if (laterOrdinaryFolderStart === undefined) {
      throw new Error("identity.non-git-folder-recovers-persisted-identity fixture is required");
    }
    const ordinaryFolderWithoutMarkerFact = {
      ...laterOrdinaryFolderStart,
      given: laterOrdinaryFolderStart.given.filter((fact) => fact.kind !== "identity-marker"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([ordinaryFolderWithoutMarkerFact])).toContain(
      `${laterOrdinaryFolderStart.id}: ordinary-folder reuse must resolve its identity marker`,
    );

    const runtimeCreationScenario = managedStackContractFixtures.find(
      ({ id }) => id === "runtime.explicit-api-overrides-auto",
    );
    if (runtimeCreationScenario === undefined) {
      throw new Error("runtime.explicit-api-overrides-auto fixture is required");
    }
    const runtimeCreationWithoutAbsentTarget = {
      ...runtimeCreationScenario,
      given: runtimeCreationScenario.given.filter((fact) => fact.kind !== "managed-target"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([runtimeCreationWithoutAbsentTarget])).toContain(
      `${runtimeCreationScenario.id}: managed creation must declare absent target stack-main-default`,
    );

    const runtimeCreationWithoutLegacyState = {
      ...runtimeCreationScenario,
      given: runtimeCreationScenario.given.filter((fact) => fact.kind !== "legacy-state"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([runtimeCreationWithoutLegacyState])).toContain(
      `${runtimeCreationScenario.id}: managed creation must declare legacy state absent`,
    );

    const credentialCreationScenario = managedStackContractFixtures.find(
      ({ id }) => id === "credentials.configured-values-are-authoritative",
    );
    if (credentialCreationScenario === undefined) {
      throw new Error("credentials.configured-values-are-authoritative fixture is required");
    }
    const credentialCreationWithoutAbsentTarget = {
      ...credentialCreationScenario,
      given: credentialCreationScenario.given.filter((fact) => fact.kind !== "managed-target"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([credentialCreationWithoutAbsentTarget])).toContain(
      `${credentialCreationScenario.id}: managed creation must declare absent target stack-main-default`,
    );

    const credentialCreationWithoutLegacyState = {
      ...credentialCreationScenario,
      given: credentialCreationScenario.given.filter((fact) => fact.kind !== "legacy-state"),
    } satisfies ManagedStackContractScenario;
    expect(validateManagedStackContractFixtures([credentialCreationWithoutLegacyState])).toContain(
      `${credentialCreationScenario.id}: managed creation must declare legacy state absent`,
    );
  });

  it("covers the approved identity journeys through public commands and APIs", () => {
    expect(
      managedStackContractFixtures
        .filter(({ area }) => area === "identity")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      [
        "identity.branch-commit-preserves-context",
        "identity.branch-copy-ambiguous-read-only",
        "identity.branch-copy-known-owner-creates-context-on-mutation",
        "identity.branch-copy-read-only-does-not-write",
        "identity.branch-create-and-switch-is-no-op",
        "identity.branch-delete-recreate-creates-context",
        "identity.branch-rebase-preserves-context",
        "identity.branch-rename-preserves-context",
        "identity.branch-reset-preserves-context",
        "identity.concurrent-create-publishes-once",
        "identity.copied-checkout-reports-duplicate-claim",
        "identity.detached-commits-reuse-checkout-context",
        "identity.folder-to-git-ambiguous-claim-fails",
        "identity.folder-to-git-exact-claim-preserves-identity",
        "identity.folder-to-git-without-claim-creates-git-identity",
        "identity.fresh-clone-creates-project-and-checkout",
        "identity.fresh-clone-ignores-tracked-marker",
        "identity.inaccessible-previous-path-fails",
        "identity.invalid-stack-name-leading-hyphen-fails",
        "identity.invalid-stack-name-repeated-dot-fails",
        "identity.invalid-stack-name-uppercase-underscore-fails",
        "identity.linked-worktrees-share-project-not-checkout",
        "identity.manual-ref-replacement-orphans-context",
        "identity.missing-previous-path-rebinds-checkout",
        "identity.moved-checkout-reuses-identity",
        "identity.named-stacks-are-context-scoped",
        "identity.new-branch-first-start-creates-stack",
        "identity.non-git-folder-first-start-persists-identity",
        "identity.non-git-folder-recovers-persisted-identity",
        "identity.original-gone-turns-copy-into-rename",
        "identity.read-only-unregistered-checkout-does-not-write",
        "identity.return-to-branch-reuses-stack",
        "identity.same-branch-in-two-worktrees-is-isolated",
        "identity.same-checkout-branch-and-name-reuses-stack",
        "identity.same-commit-different-branches-are-independent",
        "identity.symlink-alias-reuses-checkout",
        "identity.valid-stack-names-resolve-deterministically",
        "identity.bare-repository-linked-worktrees-share-project",
      ].sort(),
    );
  });

  it("persists and recovers ordinary-folder identity across starts", () => {
    const firstStart = managedStackContractFixtures.find(
      ({ id }) => id === "identity.non-git-folder-first-start-persists-identity",
    );
    const laterStart = managedStackContractFixtures.find(
      ({ id }) => id === "identity.non-git-folder-recovers-persisted-identity",
    );

    expect(firstStart).toMatchObject({
      when: { interface: "cli", argv: ["start", "--experimental"], cwd: "/work/project-a" },
      expected: {
        outcome: "create",
        selection: {
          projectId: "project-a",
          checkoutId: "checkout-a",
          contextId: "context-workspace",
          stackId: "stack-workspace-default",
        },
        writes: expect.arrayContaining([
          {
            target: "identity-marker",
            operation: "create",
            id: "marker-project-a",
            storage: "project-local-untracked",
            projectId: "project-a",
            checkoutId: "checkout-a",
            contextId: "context-workspace",
          },
        ]),
      },
    });
    expect(laterStart).toMatchObject({
      given: expect.arrayContaining([
        {
          kind: "identity-marker",
          markerId: "marker-project-a",
          workspacePath: "/work/project-a",
          projectId: "project-a",
          checkoutId: "checkout-a",
          contextId: "context-workspace",
          tracked: false,
        },
      ]),
      expected: {
        outcome: "reuse",
        selection: {
          projectId: "project-a",
          checkoutId: "checkout-a",
          contextId: "context-workspace",
          stackId: "stack-workspace-default",
        },
      },
    });
  });

  it("executes every invalid stack name through the public CLI action", () => {
    const invalidNameScenarios = managedStackContractFixtures.filter(({ id }) =>
      id.startsWith("identity.invalid-stack-name-"),
    );

    expect(
      invalidNameScenarios.map((invalidNameScenario) => ({
        action:
          invalidNameScenario.when.interface === "cli" ? invalidNameScenario.when.argv : undefined,
        names: invalidNameScenario.given.flatMap((fact) =>
          fact.kind === "stack-names" ? fact.names : [],
        ),
      })),
    ).toEqual([
      {
        action: ["start", "--experimental", "--stack", "Feature_A"],
        names: ["Feature_A"],
      },
      { action: ["start", "--experimental", "--stack", "-review"], names: ["-review"] },
      {
        action: ["start", "--experimental", "--stack", "review..two"],
        names: ["review..two"],
      },
    ]);
  });

  it("covers exact declarative ports and sticky automatic allocation", () => {
    expect(
      managedStackContractFixtures
        .filter(({ area }) => area === "ports")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      [
        "ports.config-change-on-running-stack-reports-drift",
        "ports.config-change-on-stopped-stack-applies",
        "ports.env-and-remote-values-remain-exact",
        "ports.exact-default-value-differs-from-omitted-default",
        "ports.explicit-free-port-is-used",
        "ports.explicit-port-conflict-fails",
        "ports.explicit-port-conflict-with-sibling-fails",
        "ports.later-sticky-port-collision-fails",
        "ports.new-target-allocates-and-persists-omitted-ports",
        "ports.removing-exact-key-keeps-current-port-sticky",
        "ports.running-legacy-source-fails-before-allocation",
        "ports.sibling-targets-allocate-independent-ports",
        "ports.sticky-ports-reuse-on-return",
      ].sort(),
    );
  });

  it("freezes runtime selection and the atomic native service graph", () => {
    expect(managedNativeServiceMatrix).toEqual({
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
    });

    expect(
      managedStackContractFixtures
        .filter(({ area }) => area === "runtime" || area === "native-qualification")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      [
        "native-qualification.all-services-qualify-platform",
        "native-qualification.one-service-failure-disables-platform",
        "native-qualification.unsupported-platform-fails-preflight",
        "runtime.auto-fails-when-neither-runtime-is-available",
        "runtime.auto-prefers-docker",
        "runtime.auto-selects-fully-qualified-native",
        "runtime.config-overrides-default-auto",
        "runtime.explicit-and-config-conflict-fails",
        "runtime.explicit-api-overrides-auto",
        "runtime.explicit-runtime-is-strict",
        "runtime.missing-persisted-prerequisite-fails",
        "runtime.persisted-runtime-conflict-fails",
        "runtime.persisted-runtime-reused-for-auto",
        "runtime.status-reports-one-stack-wide-runtime",
      ].sort(),
    );
  });

  it("covers read-compatible bootstrap without coupling managed and legacy timelines", () => {
    expect(
      managedStackContractFixtures
        .filter(({ area }) => area === "bootstrap")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      [
        "bootstrap.absent-legacy-starts-fresh",
        "bootstrap.existing-managed-target-ignores-legacy",
        "bootstrap.failed-copy-rolls-back",
        "bootstrap.first-start-copies-compatible-legacy-state",
        "bootstrap.incompatible-legacy-starts-fresh",
        "bootstrap.managed-and-legacy-diverge-after-copy",
        "bootstrap.retry-after-failed-copy-succeeds",
        "bootstrap.running-legacy-source-fails-without-mutation",
      ].sort(),
    );
  });

  it("covers credential authority, stability, drift, and secret boundaries", () => {
    expect(
      managedStackContractFixtures
        .filter(({ area }) => area === "credentials")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      [
        "credentials.compatible-legacy-auth-is-retained",
        "credentials.configured-values-are-authoritative",
        "credentials.explicit-change-applies-after-stop",
        "credentials.omitted-values-use-stable-defaults",
        "credentials.running-change-reports-drift",
        "credentials.unchanged-values-survive-restart",
      ].sort(),
    );
  });

  it("covers preservation, global deletion, tombstones, prune, and engine-scoped stop", () => {
    expect(
      managedStackContractFixtures
        .filter(({ area }) => area === "reclamation")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      [
        "reclamation.branch-delete-does-not-delete-data",
        "reclamation.default-stop-preserves-data",
        "reclamation.delete-orphan-by-stack-id",
        "reclamation.delete-repeat-is-idempotent",
        "reclamation.prune-removes-metadata-only",
        "reclamation.selectors-stack-and-all-conflict",
        "reclamation.selectors-stack-and-stack-id-conflict",
        "reclamation.selectors-stack-id-and-all-conflict",
        "reclamation.stop-is-engine-scoped",
      ].sort(),
    );
  });

  it("rejects every pair of explicit stop selectors through the public CLI action", () => {
    expect(
      managedStackContractFixtures
        .filter(({ id }) => id.startsWith("reclamation.selectors-"))
        .map((scenario) => (scenario.when.interface === "cli" ? scenario.when.argv : undefined)),
    ).toEqual([
      ["stop", "--experimental", "--stack", "review", "--stack-id", "stack-main-default"],
      ["stop", "--experimental", "--stack", "review", "--all"],
      ["stop", "--experimental", "--stack-id", "stack-main-default", "--all"],
    ]);
  });

  it("freezes the direct, managed, repository, CLI, and portable runtime boundaries", () => {
    expect(
      managedStackContractFixtures
        .filter(({ area }) => area === "api-boundary")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      [
        "api-boundary.cli-projects-shared-managed-results",
        "api-boundary.direct-create-stack-is-ephemeral",
        "api-boundary.managed-api-accepts-injected-repository",
        "api-boundary.managed-api-accepts-isolated-state-root",
        "api-boundary.managed-surface-is-node-and-bun-portable",
        "api-boundary.repository-contract-is-storage-agnostic",
      ].sort(),
    );
  });

  it("keeps public createStack usage isolated when state roots are omitted", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "supabase-direct-contract-"));
    const projectDir = join(testRoot, "project");
    const cacheRoot = join(testRoot, "cache");
    const gitConfig = join(projectDir, ".git", "config");
    const identityMarker = join(projectDir, ".supabase", "identity.json");
    const registrySentinel = join(cacheRoot, "managed-registry.json");

    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(join(projectDir, ".supabase"), { recursive: true });
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(gitConfig, "[core]\n\trepositoryformatversion = 0\n");
    writeFileSync(identityMarker, '{"sentinel":true}\n');
    writeFileSync(registrySentinel, '{"sentinel":true}\n');

    try {
      const stack = await createStack({ cacheRoot, projectDir, startupMode: "lazy" });
      try {
        expect(stack).toMatchObject({
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
          dbUrl: expect.stringMatching(/^postgresql:\/\//),
        });
      } finally {
        await stack.dispose();
      }

      expect(readFileSync(gitConfig, "utf8")).toBe("[core]\n\trepositoryformatversion = 0\n");
      expect(readFileSync(identityMarker, "utf8")).toBe('{"sentinel":true}\n');
      expect(readFileSync(registrySentinel, "utf8")).toBe('{"sentinel":true}\n');
      expect(existsSync(join(cacheRoot, "projects"))).toBe(false);
      expect(readdirSync(cacheRoot).sort()).toEqual(["managed-registry.json"]);
      expect(readdirSync(projectDir).sort()).toEqual([".git", ".supabase"]);
      expect(readdirSync(join(projectDir, ".supabase")).sort()).toEqual(["identity.json"]);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("reuses the existing stack when a developer returns to a branch", () => {
    const scenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.return-to-branch-reuses-stack",
    );

    expect(scenario).toEqual({
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
    });
  });

  it("reports an ambiguous copied branch without mutating either branch", () => {
    const scenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.branch-copy-ambiguous-read-only",
    );

    expect(scenario?.when).toEqual({
      interface: "cli",
      argv: ["status", "--experimental", "--output", "json"],
      cwd: "checkout-a",
    });
    expect(scenario?.expected).toEqual({
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
    });
  });

  it("fails on an occupied declarative port instead of relocating the stack", () => {
    const scenario = managedStackContractFixtures.find(
      ({ id }) => id === "ports.explicit-port-conflict-fails",
    );

    expect(scenario).toMatchObject({
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
      },
      expected: {
        outcome: "error",
        error: {
          code: "exact_port_occupied",
          recovery: [
            "Stop the process using port 54321",
            "Change api.port in supabase/config.toml",
            "Remove api.port to use automatic allocation",
          ],
        },
        writes: [],
        runtimeEffects: [],
        output: {
          json: {
            outcome: "error",
            code: "exact_port_occupied",
            port: 54321,
            config_key: "api.port",
          },
        },
      },
    });
  });

  it("keeps an existing stack on its persisted runtime", () => {
    const scenario = managedStackContractFixtures.find(
      ({ id }) => id === "runtime.persisted-runtime-conflict-fails",
    );

    expect(scenario).toMatchObject({
      area: "runtime",
      given: expect.arrayContaining([
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
      ]),
      when: {
        interface: "cli",
        argv: ["start", "--experimental", "--runtime", "native"],
      },
      expected: {
        outcome: "error",
        error: {
          code: "runtime_conflicts_with_persisted_stack",
          recovery: [
            "Start a new named stack with --stack <name>",
            "Delete and recreate stack-main-default",
          ],
        },
        writes: [],
        runtimeEffects: [],
        output: {
          json: {
            outcome: "error",
            code: "runtime_conflicts_with_persisted_stack",
            persisted_runtime: "docker",
            requested_runtime: "native",
          },
        },
      },
    });
  });

  it("bootstraps compatible stopped legacy state without mutating it", () => {
    const scenario = managedStackContractFixtures.find(
      ({ id }) => id === "bootstrap.first-start-copies-compatible-legacy-state",
    );

    expect(scenario).toMatchObject({
      area: "bootstrap",
      given: expect.arrayContaining([
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
      ]),
      when: {
        interface: "cli",
        argv: ["start", "--experimental"],
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
          bootstrap: "copied",
          legacy_state_mutated: false,
          credentials: "preserved",
        },
        output: {
          json: {
            outcome: "create",
            bootstrap: "copied",
            stack_id: "stack-main-default",
          },
        },
      },
    });
  });

  it("deletes an orphaned stack by opaque ID without a checkout", () => {
    const scenario = managedStackContractFixtures.find(
      ({ id }) => id === "reclamation.delete-orphan-by-stack-id",
    );

    expect(scenario).toMatchObject({
      area: "reclamation",
      given: [
        {
          kind: "stack",
          stackId: "stack-orphan",
          lifecycle: "running",
          orphaned: true,
        },
      ],
      when: {
        interface: "cli",
        argv: ["stop", "--experimental", "--stack-id", "stack-orphan", "--no-backup"],
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
        output: {
          json: {
            outcome: "delete",
            stack_id: "stack-orphan",
            tombstoned: true,
          },
        },
      },
    });
  });

  it("keeps direct createStack usage isolated from system-wide managed state", () => {
    const scenario = managedStackContractFixtures.find(
      ({ id }) => id === "api-boundary.direct-create-stack-is-ephemeral",
    );

    expect(scenario).toMatchObject({
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
    });
  });
});
