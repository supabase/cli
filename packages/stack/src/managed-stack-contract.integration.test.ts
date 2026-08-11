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
  type ManagedStackContractScenario,
  validateManagedStackContractFixtures,
} from "./testing.ts";
import { DEFAULT_VERSIONS, SERVICE_NAMES } from "./versions.ts";

describe("managed stack acceptance contract", () => {
  it("keeps every shared scenario readable and executable through a public interface", () => {
    expect(validateManagedStackContractFixtures(managedStackContractFixtures)).toEqual([]);
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
    if (
      reuse.expected.selection === undefined ||
      reuse.expected.output.json === undefined ||
      portConflict.expected.error === undefined ||
      portConflict.expected.output.json === undefined
    ) {
      throw new Error("lint examples require selected and structured fixture outputs");
    }

    const cases: ReadonlyArray<{
      readonly fixtures: ReadonlyArray<ManagedStackContractScenario>;
      readonly expectedError: string;
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
    ];

    for (const testCase of cases) {
      expect(validateManagedStackContractFixtures(testCase.fixtures)).toContain(
        testCase.expectedError,
      );
    }
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
        input: {},
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
            handle: "stack-handle",
            temporaryRoots: ["stack", "runtime"],
          },
        },
      },
    });
  });
});
