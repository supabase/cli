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
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createStack } from "./node.ts";
import { reservePortSet } from "./PortAllocator.ts";
import {
  managedNativePlatformByNodeTarget,
  managedNativePlatformFromNode,
  managedNativeServiceMatrix,
  managedStackContractFixtures,
  type ManagedStackContractScenario,
  validateManagedStackContractFixtures,
} from "./testing.ts";
import type { ManagedStackContractRecoveryOperation } from "./managed-stack-contract.ts";
import { DEFAULT_VERSIONS, SERVICE_NAMES } from "./versions.ts";

const { createdTempRoots } = vi.hoisted(() => ({ createdTempRoots: new Array<string>() }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    mkdtempSync(prefix: string) {
      const root = fs.mkdtempSync(prefix);
      createdTempRoots.push(root);
      return root;
    },
  };
});

const projectDirectStackHandle = (stack: { readonly url: string; readonly dbUrl: string }) => ({
  url: stack.url.replace(/:\d+$/, ":<api-port>"),
  dbUrl: stack.dbUrl.replace(/:\d+\//, ":<db-port>/"),
});

const isAddressInUse = (error: unknown, depth = 0): boolean => {
  if (depth > 4 || !(error instanceof Error)) return false;
  const cause: unknown = error.cause;
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    if (Reflect.get(cause, "code") === "EADDRINUSE") return true;
  }
  return isAddressInUse(cause, depth + 1);
};

const freshPortPair = async (): Promise<readonly [number, number]> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.acquireRelease(
        reservePortSet([
          { field: "apiPort", selection: { kind: "automatic" } },
          { field: "dbPort", selection: { kind: "automatic" } },
        ]),
        (lease) => lease.releaseAll,
      ).pipe(
        Effect.map((lease) => {
          const apiPort = lease.ports.apiPort;
          const dbPort = lease.ports.dbPort;
          if (apiPort === undefined || dbPort === undefined) {
            throw new Error("Ephemeral port reservation returned an incomplete pair");
          }
          return [apiPort, dbPort] as const;
        }),
      ),
    ),
  );

/** Transfer a fresh exact pair into public createStack across a bounded bind handoff retry. */
const createStackWithFreshPorts = async (
  config: Parameters<typeof createStack>[0],
): Promise<Awaited<ReturnType<typeof createStack>>> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [apiPort, dbPort] = await freshPortPair();
    try {
      return await createStack({
        ...config,
        port: apiPort,
        postgres: { ...config?.postgres, port: dbPort },
      });
    } catch (error) {
      if (!isAddressInUse(error) || attempt === 2) throw error;
    }
  }
  throw new Error("Direct stack bind handoff exhausted retries");
};

const snapshotDirectoryTree = (root: string): ReadonlyArray<string> => {
  const paths: Array<string> = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = join(relativeDirectory, entry.name);
      paths.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), relativePath);
      }
    }
  };

  visit(root, "");
  return paths.sort();
};

describe("managed stack acceptance contract", () => {
  it("keeps every shared scenario readable and executable through a public interface", () => {
    expect(validateManagedStackContractFixtures(managedStackContractFixtures)).toEqual([]);
    expect(managedStackContractFixtures).toHaveLength(104);
  });

  it("lints structural, referential, effect, and projection mistakes", () => {
    const findScenario = (id: string): ManagedStackContractScenario => {
      const scenario: ManagedStackContractScenario | undefined = managedStackContractFixtures.find(
        (candidate) => candidate.id === id,
      );
      if (scenario === undefined) {
        throw new Error(`${id} fixture is required`);
      }
      return scenario;
    };

    const reuse = findScenario("identity.return-to-branch-reuses-stack");
    const portConflict = findScenario("ports.explicit-port-conflict-fails");
    const readOnly = findScenario("identity.branch-copy-read-only-does-not-write");
    const noOp = findScenario("reclamation.delete-repeat-is-idempotent");
    const freshBootstrap = findScenario("bootstrap.absent-legacy-starts-fresh");
    const failedBootstrap = findScenario("bootstrap.failed-copy-rolls-back");
    const repositoryContract = findScenario("api-boundary.repository-contract-is-storage-agnostic");
    const persistedRuntime = findScenario("runtime.persisted-runtime-reused-for-auto");
    const defaultOutputCli = findScenario("identity.non-git-folder-first-start-persists-identity");
    const jsonOutputCli = findScenario("identity.read-only-unregistered-checkout-does-not-write");
    const repositoryAction = repositoryContract.when;
    const reusedStack = reuse.given.find((fact) => fact.kind === "stack");
    if (
      reuse.expected.selection === undefined ||
      reuse.when.interface !== "cli" ||
      reuse.expected.output.json === undefined ||
      reuse.expected.output.human === undefined ||
      reusedStack === undefined ||
      portConflict.expected.error === undefined ||
      portConflict.expected.output.json === undefined ||
      freshBootstrap.expected.details === undefined ||
      freshBootstrap.expected.output.json === undefined ||
      failedBootstrap.expected.error === undefined ||
      failedBootstrap.expected.output.api === undefined ||
      jsonOutputCli.when.interface !== "cli" ||
      repositoryAction.interface !== "managed-api"
    ) {
      throw new Error("lint examples require selected and structured fixture outputs");
    }

    const cases: ReadonlyArray<{
      readonly fixtures: ReadonlyArray<ManagedStackContractScenario>;
      readonly expectedError: string | ReadonlyArray<string>;
    }> = [
      {
        fixtures: [
          {
            ...reuse,
            expected: { ...reuse.expected, writes: [] },
          },
        ],
        expectedError: `${reuse.id}: start runtime effect requires a matching state write`,
      },
      {
        fixtures: [
          {
            ...reuse,
            expected: {
              ...reuse.expected,
              selection: { ...reuse.expected.selection, stackId: "stack-undeclared" },
            },
          },
        ],
        expectedError: `${reuse.id}: selection references undeclared ID stack-undeclared`,
      },
      {
        fixtures: [
          {
            ...reuse,
            expected: {
              ...reuse.expected,
              output: {
                ...reuse.expected.output,
                json: { ...reuse.expected.output.json, outcome: "create" },
              },
            },
          },
        ],
        expectedError: `${reuse.id}: projected outcome disagrees with the managed result`,
      },
      {
        fixtures: [
          {
            ...portConflict,
            expected: {
              ...portConflict.expected,
              error: { ...portConflict.expected.error, code: "exact_port_occupied" },
              output: {
                ...portConflict.expected.output,
                json: { ...portConflict.expected.output.json, code: "exact_port_occupied" },
              },
            },
          },
        ],
        expectedError: `${portConflict.id}: diagnostic code exact_port_occupied must use SCREAMING_SNAKE_CASE`,
      },
      {
        fixtures: [
          {
            ...failedBootstrap,
            expected: {
              ...failedBootstrap.expected,
              output: {
                ...failedBootstrap.expected.output,
                api: { outcome: "error" },
              },
            },
          },
        ],
        expectedError: [
          `${failedBootstrap.id}: API projection requires a code`,
          `${failedBootstrap.id}: API recovery disagrees with the managed result`,
        ],
      },
      {
        fixtures: [
          {
            ...readOnly,
            expected: {
              ...readOnly.expected,
              writes: [{ target: "registry", operation: "update", id: "context-main" }],
            },
          },
        ],
        expectedError: `${readOnly.id}: report outcome must not mutate state`,
      },
      {
        fixtures: [reuse, reuse],
        expectedError: `${reuse.id}: duplicate scenario ID`,
      },
      {
        fixtures: [
          {
            ...reuse,
            expected: {
              ...reuse.expected,
              writes: [
                ...reuse.expected.writes,
                { target: "registry", operation: "publish", id: "" },
              ],
            },
          },
        ],
        expectedError: `${reuse.id}: write ID is required`,
      },
      {
        fixtures: [
          {
            ...reuse,
            expected: {
              ...reuse.expected,
              runtimeEffects: [
                ...reuse.expected.runtimeEffects,
                { operation: "start", stackId: "" },
              ],
            },
          },
        ],
        expectedError: `${reuse.id}: runtime effect stack ID is required`,
      },
      {
        fixtures: [
          {
            ...reuse,
            given: reuse.given.map((fact) =>
              fact.kind === "checkout" ? { ...fact, projectId: "" } : fact,
            ),
            expected: {
              ...reuse.expected,
              selection: { ...reuse.expected.selection, projectId: "" },
              output: {
                ...reuse.expected.output,
                json: { ...reuse.expected.output.json, project_id: "" },
              },
            },
          },
        ],
        expectedError: `${reuse.id}: declared ID is required`,
      },
      {
        fixtures: [
          {
            ...freshBootstrap,
            expected: {
              ...freshBootstrap.expected,
              output: {
                ...freshBootstrap.expected.output,
                json: {
                  ...freshBootstrap.expected.output.json,
                  legacy_state_mutated: { value: true },
                },
              },
            },
          },
        ],
        expectedError: `${freshBootstrap.id}: projected legacy_state_mutated disagrees with the managed result`,
      },
      {
        fixtures: [
          {
            ...portConflict,
            expected: {
              ...portConflict.expected,
              error: {
                ...portConflict.expected.error,
                message: " ",
                recovery: [" "],
              },
            },
          },
        ],
        expectedError: [
          `${portConflict.id}: diagnostic message is required`,
          `${portConflict.id}: diagnostic recovery steps must not be blank`,
        ],
      },
      {
        fixtures: [
          {
            ...noOp,
            expected: {
              ...noOp.expected,
              writes: [{ target: "registry", operation: "update", id: "stack-orphan" }],
            },
          },
        ],
        expectedError: `${noOp.id}: no-op outcome must not mutate state`,
      },
      {
        fixtures: [
          {
            ...reuse,
            expected: {
              ...reuse.expected,
              selection: { ...reuse.expected.selection, stackName: "review" },
              output: {
                ...reuse.expected.output,
                json: { ...reuse.expected.output.json, stack_name: "review" },
              },
            },
          },
        ],
        expectedError: `${reuse.id}: selected stack name review disagrees with stack stack-main-default`,
      },
      {
        fixtures: [
          {
            ...reuse,
            given: [...reuse.given, { ...reusedStack, lifecycle: "running" }],
          },
        ],
        expectedError: `${reuse.id}: conflicting stack facts for ID stack-main-default`,
      },
      {
        fixtures: [
          {
            ...reuse,
            expected: {
              ...reuse.expected,
              output: {
                ...reuse.expected.output,
                human: { ...reuse.expected.output.human, summary: " " },
              },
            },
          },
        ],
        expectedError: `${reuse.id}: human summary is required`,
      },
      {
        fixtures: [
          {
            ...reuse,
            expected: {
              ...reuse.expected,
              output: {
                ...reuse.expected.output,
                json: { ...reuse.expected.output.json, stackName: "default" },
                api: { stack_id: "stack-main-default" },
              },
            },
          },
        ],
        expectedError: [
          `${reuse.id}: JSON projection key stackName must use snake_case`,
          `${reuse.id}: API projection key stack_id must not use snake_case`,
        ],
      },
      {
        fixtures: [{ ...reuse, when: { ...reuse.when, cwd: "another-checkout" } }],
        expectedError: `${reuse.id}: cwd another-checkout does not match a given workspace or checkout path`,
      },
      {
        fixtures: [
          {
            ...reuse,
            given: [
              ...reuse.given,
              {
                kind: "checkout",
                path: "checkout-b",
                projectId: "project-a",
                checkoutId: "checkout-b",
              },
            ],
            expected: {
              ...reuse.expected,
              selection: { ...reuse.expected.selection, checkoutId: "checkout-b" },
            },
          },
        ],
        expectedError: `${reuse.id}: selected checkout checkout-b disagrees with stack stack-main-default`,
      },
      {
        fixtures: managedStackContractFixtures.map((scenario) =>
          scenario.id === repositoryContract.id
            ? {
                ...repositoryContract,
                when: {
                  ...repositoryAction,
                  input: {
                    ...repositoryAction.input,
                    scenarioId: "identity.missing-contract-scenario",
                  },
                },
              }
            : scenario,
        ),
        expectedError: `${repositoryContract.id}: references unknown scenario ID identity.missing-contract-scenario`,
      },
      {
        fixtures: [{ ...reuse, when: { ...reuse.when, argv: [" "] } }],
        expectedError: `${reuse.id}: argv must start with a public command`,
      },
      {
        fixtures: [
          {
            ...persistedRuntime,
            given: [
              ...persistedRuntime.given,
              {
                kind: "persisted-runtime",
                stackId: "stack-main-default",
                runtime: "docker",
              },
            ],
          },
        ],
        expectedError: `${persistedRuntime.id}: conflicting persisted-runtime facts for ID stack-main-default`,
      },
      {
        fixtures: [
          {
            ...freshBootstrap,
            given: [
              ...freshBootstrap.given,
              {
                kind: "concurrent-operation",
                operation: "create-stack",
                target: "stack-main-default",
                contenders: Number.POSITIVE_INFINITY,
              },
            ],
          },
        ],
        expectedError: `${freshBootstrap.id}: given facts contain a non-finite number`,
      },
      {
        fixtures: [
          {
            ...freshBootstrap,
            expected: {
              ...freshBootstrap.expected,
              details: { ...freshBootstrap.expected.details, invalid_number: Number.NaN },
            },
          },
        ],
        expectedError: `${freshBootstrap.id}: managed detail data contains a non-finite number`,
      },
      {
        fixtures: [
          {
            ...defaultOutputCli,
            expected: {
              ...defaultOutputCli.expected,
              output: { ...defaultOutputCli.expected.output, human: undefined },
            },
          },
        ],
        expectedError: `${defaultOutputCli.id}: default CLI invocation requires a human projection`,
      },
      {
        fixtures: [
          {
            ...jsonOutputCli,
            expected: {
              ...jsonOutputCli.expected,
              output: { ...jsonOutputCli.expected.output, json: undefined },
            },
          },
        ],
        expectedError: `${jsonOutputCli.id}: JSON CLI invocation requires a JSON projection`,
      },
      {
        fixtures: [
          {
            ...jsonOutputCli,
            when: {
              ...jsonOutputCli.when,
              argv: ["status", "--experimental", "--output-format=json"],
            },
            expected: {
              ...jsonOutputCli.expected,
              output: { ...jsonOutputCli.expected.output, json: undefined },
            },
          },
        ],
        expectedError: `${jsonOutputCli.id}: JSON CLI invocation requires a JSON projection`,
      },
      {
        fixtures: [
          {
            ...reuse,
            given: [
              ...reuse.given,
              { kind: "branch", name: "feat-a", contextId: "context-feat", checkedOut: false },
            ],
            expected: {
              ...reuse.expected,
              selection: { ...reuse.expected.selection, contextId: "context-feat" },
              output: {
                ...reuse.expected.output,
                human: {
                  ...reuse.expected.output.human,
                  fields: { ...reuse.expected.output.human.fields, contextId: "context-feat" },
                },
                json: { ...reuse.expected.output.json, context_id: "context-feat" },
              },
            },
          },
        ],
        expectedError: `${reuse.id}: selected context context-feat disagrees with stack stack-main-default`,
      },
    ];

    for (const testCase of cases) {
      const expectedErrors =
        typeof testCase.expectedError === "string"
          ? [testCase.expectedError]
          : testCase.expectedError;
      for (const expectedError of expectedErrors) {
        expect(validateManagedStackContractFixtures(testCase.fixtures)).toContain(expectedError);
      }
    }
  });

  it("validates recovery operation payloads", () => {
    const scenario: ManagedStackContractScenario | undefined = managedStackContractFixtures.find(
      ({ id }) => id === "reclamation.prune-preserves-conflict-evidence",
    );
    if (scenario === undefined) {
      throw new Error("recovery operation fixture is required");
    }
    const validOperation = JSON.parse(JSON.stringify(scenario));
    validOperation.expected.warning.recoveryOperations = [
      { operation: "prune", recordIds: ["stack-conflict"] },
    ];
    expect(validateManagedStackContractFixtures([validOperation])).toEqual([]);
    const recoveryOperation: ManagedStackContractRecoveryOperation | undefined =
      validOperation.expected.warning.recoveryOperations[0];
    expect(recoveryOperation?.operation).toBe("prune");

    const emptyOperation = JSON.parse(JSON.stringify(validOperation));
    emptyOperation.expected.warning.recoveryOperations[0].operation = "";
    expect(validateManagedStackContractFixtures([emptyOperation])).toContain(
      `${scenario.id}: recovery operation name is required`,
    );

    const nonArrayRecordIds = JSON.parse(JSON.stringify(validOperation));
    nonArrayRecordIds.expected.warning.recoveryOperations[0] = {
      operation: "prune",
      recordIds: null,
    };
    expect(validateManagedStackContractFixtures([nonArrayRecordIds])).toContain(
      `${scenario.id}: recovery operation prune record IDs must be an array`,
    );

    const nullRecordId = JSON.parse(JSON.stringify(validOperation));
    nullRecordId.expected.warning.recoveryOperations[0] = {
      operation: "prune",
      recordIds: [null],
    };
    expect(validateManagedStackContractFixtures([nullRecordId])).toContain(
      `${scenario.id}: recovery operation prune record ID is required`,
    );

    const nullEntry = JSON.parse(JSON.stringify(validOperation));
    nullEntry.expected.warning.recoveryOperations = [null];
    expect(validateManagedStackContractFixtures([nullEntry])).toContain(
      `${scenario.id}: recovery operation must be an object`,
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
        "identity.in-place-ref-update-preserves-context",
        "identity.invalid-stack-name-double-dot-fails",
        "identity.invalid-stack-name-leading-hyphen-fails",
        "identity.invalid-stack-name-repeated-dot-fails",
        "identity.invalid-stack-name-single-dot-fails",
        "identity.invalid-stack-name-too-long-fails",
        "identity.invalid-stack-name-trailing-hyphen-fails",
        "identity.invalid-stack-name-uppercase-underscore-fails",
        "identity.linked-worktrees-share-project-not-checkout",
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

  it("does not advertise unsupported recovery projections", () => {
    const unsupportedScenarioIds = new Set([
      "identity.recycled-previous-path-rebinds-checkout",
      "identity.superseded-path-reappearance-blocks-both-claims",
      "identity.interrupted-folder-to-git-transition-reports-without-starting",
    ]);
    const advertisedScenarioIds = managedStackContractFixtures
      .filter(({ id }) => unsupportedScenarioIds.has(id))
      .map(({ id }) => id);
    expect(advertisedScenarioIds).toEqual([]);

    const advertisedRecoveryOperations = managedStackContractFixtures.flatMap((scenario) => {
      const expected: ManagedStackContractScenario["expected"] = scenario.expected;
      return [expected.error, expected.warning].flatMap(
        (diagnostic) => diagnostic?.recoveryOperations?.map(({ operation }) => operation) ?? [],
      );
    });
    expect(advertisedRecoveryOperations).not.toContain("newCheckout");

    const conflictPrune = managedStackContractFixtures.find(
      ({ id }) => id === "reclamation.prune-preserves-conflict-evidence",
    );
    const conflictExpected: ManagedStackContractScenario["expected"] | undefined =
      conflictPrune?.expected;
    expect(conflictExpected?.warning?.recoveryOperations).toBeUndefined();
  });

  it("shares branch contexts across worktrees while checkout identity keeps stacks isolated", () => {
    const findIdentityScenario = (id: string): ManagedStackContractScenario => {
      const scenario = managedStackContractFixtures.find((candidate) => candidate.id === id);
      if (scenario === undefined) {
        throw new Error(`${id} fixture is required`);
      }
      return scenario;
    };
    const linkedWorktrees = findIdentityScenario(
      "identity.linked-worktrees-share-project-not-checkout",
    );
    const forcedBranch = findIdentityScenario("identity.same-branch-in-two-worktrees-is-isolated");
    const bareWorktrees = findIdentityScenario(
      "identity.bare-repository-linked-worktrees-share-project",
    );

    expect(linkedWorktrees).toMatchObject({
      expected: {
        selection: { checkoutId: "checkout-b", contextId: "context-main" },
        writes: expect.arrayContaining([
          {
            target: "git-config",
            operation: "create",
            id: "context-main",
            scope: "common",
            owner: "main",
          },
        ]),
      },
    });
    expect(forcedBranch).toMatchObject({
      given: expect.arrayContaining([
        expect.objectContaining({ kind: "branch", name: "main", contextId: "context-main" }),
        {
          kind: "stack",
          name: "default",
          stackId: "stack-a-main-default",
          checkoutId: "checkout-a",
          contextId: "context-main",
          lifecycle: "running",
        },
      ]),
      expected: {
        selection: {
          checkoutId: "checkout-b",
          contextId: "context-main",
          stackId: "stack-b-main-default",
        },
      },
    });
    expect(forcedBranch.expected.writes.filter((write) => write.target === "git-config")).toEqual(
      [],
    );
    expect(bareWorktrees).toMatchObject({
      given: expect.arrayContaining([
        {
          kind: "stack",
          name: "default",
          stackId: "stack-a-main-default",
          checkoutId: "checkout-a",
          contextId: "context-main",
          lifecycle: "running",
        },
      ]),
      expected: {
        selection: { checkoutId: "checkout-b", contextId: "context-main" },
      },
    });
    expect(bareWorktrees.expected.writes.filter((write) => write.target === "git-config")).toEqual(
      [],
    );
  });

  it("does not rewrite branch context after Git has preserved a rename", () => {
    for (const id of [
      "identity.branch-rename-preserves-context",
      "identity.original-gone-turns-copy-into-rename",
    ]) {
      const scenario = managedStackContractFixtures.find((candidate) => candidate.id === id);
      expect(scenario?.expected.writes.filter((write) => write.target === "git-config")).toEqual(
        [],
      );
    }
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
            workspacePath: "/work/project-a",
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
      {
        action: ["start", "--experimental", "--stack", "."],
        names: ["."],
      },
      {
        action: ["start", "--experimental", "--stack", ".."],
        names: [".."],
      },
      {
        action: ["start", "--experimental", "--stack", "review-"],
        names: ["review-"],
      },
      {
        action: ["start", "--experimental", "--stack", "a".repeat(64)],
        names: ["a".repeat(64)],
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
        "ports.stopped-siblings-with-shared-exact-config-coexist",
        "ports.sticky-ports-reuse-on-return",
      ].sort(),
    );
  });

  it("freezes runtime selection and the atomic native service graph", () => {
    expect(managedNativePlatformByNodeTarget).toEqual({
      "darwin-arm64": "darwin-arm64",
      "darwin-x64": "darwin-x64",
      "linux-arm64": "linux-arm64",
      "linux-x64": "linux-amd64",
      "win32-arm64": "windows-arm64",
      "win32-x64": "windows-amd64",
    });
    expect(managedNativePlatformFromNode("linux", "x64")).toBe("linux-amd64");
    expect(managedNativePlatformFromNode("linux", "arm64")).toBe("linux-arm64");
    expect(managedNativePlatformFromNode("win32", "x64")).toBe("windows-amd64");
    expect(managedNativePlatformByNodeTarget).toHaveProperty(`${process.platform}-${process.arch}`);

    expect(managedNativeServiceMatrix).toEqual({
      targetPlatforms: ["darwin-arm64", "linux-amd64", "linux-arm64"],
      unsupportedPlatforms: ["darwin-x64", "windows-amd64", "windows-arm64"],
      services: SERVICE_NAMES.map((service) => [service, DEFAULT_VERSIONS[service]]),
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
        "credentials.plaintext-secrets-stay-out-of-global-state",
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
        "reclamation.prune-preserves-conflict-evidence",
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
        "api-boundary.direct-create-stack-keeps-omitted-runtime-root-temporary",
        "api-boundary.direct-create-stack-keeps-omitted-stack-root-temporary",
        "api-boundary.direct-dispose-removes-temporary-roots",
        "api-boundary.managed-api-accepts-injected-repository",
        "api-boundary.managed-api-accepts-isolated-state-root",
        "api-boundary.managed-surface-is-node-and-bun-portable",
        "api-boundary.repository-contract-is-storage-agnostic",
      ].sort(),
    );
  });

  it("keeps public createStack usage isolated when state roots are omitted", async () => {
    const scenario: ManagedStackContractScenario | undefined = managedStackContractFixtures.find(
      ({ id }) => id === "api-boundary.direct-create-stack-is-ephemeral",
    );
    if (scenario?.expected.output.api === undefined) {
      throw new Error("direct createStack fixture requires its public API projection");
    }
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
    const gitTreeBefore = snapshotDirectoryTree(join(projectDir, ".git"));

    try {
      const createdRootIndex = createdTempRoots.length;
      const stack = await createStackWithFreshPorts({
        cacheRoot,
        projectDir,
        startupMode: "lazy",
      });
      const generatedRoots = createdTempRoots.slice(createdRootIndex);
      try {
        expect(projectDirectStackHandle(stack)).toEqual(scenario.expected.output.api);
        expect(generatedRoots).toHaveLength(2);
        expect(generatedRoots.every(existsSync)).toBe(true);
      } finally {
        expect(await stack.dispose()).toBeUndefined();
      }

      expect(generatedRoots.every((root) => !existsSync(root))).toBe(true);
      expect(readFileSync(gitConfig, "utf8")).toBe("[core]\n\trepositoryformatversion = 0\n");
      expect(snapshotDirectoryTree(join(projectDir, ".git"))).toEqual(gitTreeBefore);
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

  it("keeps explicitly supplied state roots while disposing each omitted root independently", async () => {
    const explicitRootKinds: ReadonlyArray<"runtime" | "stack"> = ["stack", "runtime"];

    for (const explicitRootKind of explicitRootKinds) {
      const scenarioId =
        explicitRootKind === "stack"
          ? "api-boundary.direct-create-stack-keeps-omitted-runtime-root-temporary"
          : "api-boundary.direct-create-stack-keeps-omitted-stack-root-temporary";
      const scenario: ManagedStackContractScenario | undefined = managedStackContractFixtures.find(
        ({ id }) => id === scenarioId,
      );
      if (scenario?.expected.output.api === undefined) {
        throw new Error(`${scenarioId} fixture requires its public API projection`);
      }
      const testRoot = mkdtempSync(join(tmpdir(), "supabase-partial-root-contract-"));
      const projectDir = join(testRoot, "project");
      const cacheRoot = join(testRoot, "cache");
      const explicitRoot = join(testRoot, `${explicitRootKind}-root`);
      const sentinel = join(explicitRoot, "caller-owned");

      mkdirSync(projectDir, { recursive: true });
      mkdirSync(cacheRoot, { recursive: true });
      mkdirSync(explicitRoot, { recursive: true });
      writeFileSync(sentinel, "caller-owned\n");

      try {
        const createdRootIndex = createdTempRoots.length;
        const explicitConfig =
          explicitRootKind === "stack"
            ? { stackRoot: explicitRoot }
            : { runtimeRoot: explicitRoot };
        const stack = await createStackWithFreshPorts({
          cacheRoot,
          projectDir,
          startupMode: "lazy",
          ...explicitConfig,
        });
        const generatedRoots = createdTempRoots.slice(createdRootIndex);
        const generatedRoot = generatedRoots[0];
        if (generatedRoot === undefined) {
          throw new Error("createStack must generate the omitted state root");
        }

        try {
          expect(projectDirectStackHandle(stack)).toEqual(scenario.expected.output.api);
          expect(generatedRoots).toHaveLength(1);
          expect(existsSync(generatedRoot)).toBe(true);
        } finally {
          expect(await stack.dispose()).toBeUndefined();
        }

        expect(existsSync(generatedRoot)).toBe(false);
        expect(readFileSync(sentinel, "utf8")).toBe("caller-owned\n");
        expect(existsSync(explicitRoot)).toBe(true);
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
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
          checkoutId: "checkout-a",
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
      argv: ["status", "--experimental", "--output-format", "json"],
      cwd: "checkout-a",
    });
    expect(scenario?.given).toEqual(
      expect.arrayContaining([
        {
          kind: "identity-transition",
          operation: "branch-copy",
          from: "main",
          to: "feat-copy",
          originalExists: true,
        },
        {
          kind: "identity-claim",
          scope: "context",
          id: "context-main",
          status: "ambiguous",
        },
      ]),
    );
    expect(scenario?.expected).toEqual({
      outcome: "error",
      error: {
        code: "AMBIGUOUS_CONTEXT_OWNER",
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
          code: "AMBIGUOUS_CONTEXT_OWNER",
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
          code: "EXACT_PORT_OCCUPIED",
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
            code: "EXACT_PORT_OCCUPIED",
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
          code: "RUNTIME_CONFLICTS_WITH_PERSISTED_STACK",
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
            code: "RUNTIME_CONFLICTS_WITH_PERSISTED_STACK",
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
          checkoutId: "checkout-orphan",
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
          stackRoot: "omitted",
          runtimeRoot: "omitted",
        },
      ],
      when: {
        interface: "stack-api",
        method: "createStack",
        input: { startupMode: "lazy" },
      },
      expected: {
        outcome: "create",
        writes: [
          {
            target: "temporary-root",
            operation: "create",
            id: "ephemeral-stack-root",
            root: "stack",
          },
          {
            target: "temporary-root",
            operation: "create",
            id: "ephemeral-runtime-root",
            root: "runtime",
          },
        ],
        runtimeEffects: [],
        details: {
          git_inspected: false,
          identity_marker_created: false,
          global_registry_mutated: false,
          temporary_roots: ["stack", "runtime"],
        },
        output: {
          api: {
            url: "http://127.0.0.1:<api-port>",
            dbUrl: "postgresql://postgres:postgres@127.0.0.1:<db-port>/postgres",
          },
        },
      },
    });
  });
});
