import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/cli";

import { commandTreeFor } from "../../../tests/helpers/command-flags.ts";
import type { TreeNode } from "../../../tests/helpers/command-flags.ts";
import { OPERATIONS } from "../../../tests/helpers/operation-table.ts";
import type { PermissionVariant } from "../../../tests/helpers/permission-registry.ts";
import { readPermissions } from "../command-permissions/command-permissions.annotation.ts";
import { TargetPolicy, readTargetPolicy, withTargetPolicy } from "./target-policy.ts";
import type { TargetGroup, TargetPolicyShape } from "./target-policy.ts";

const VARIANTS: ReadonlyArray<{ readonly name: string; readonly variant: PermissionVariant }> = [
  { name: "default backend", variant: undefined },
  {
    name: "stack backend",
    variant: { stackBackend: "stack", computeEnabled: true } satisfies Required<
      NonNullable<PermissionVariant>
    >,
  },
];

/** Non-GET operations a leaf may call without hosted-mutation consent, with the reason. */
const CONSENT_FREE_OPERATIONS: ReadonlyMap<string, string> = new Map([
  [
    "v1-create-login-role",
    "mints a short-lived login role for the connection; revisit when connection setup asks for consent",
  ],
  ["v1-delete-network-bans", "removes the caller's own ban only when the token permits it"],
  ["v1-list-all-network-bans", "a POST that only reads the ban list"],
  ["v1-verify-dns-config", "re-runs verification and changes no configuration"],
  ["v1-check-vanity-subdomain-availability", "a POST that only reads availability"],
]);

/** Non-GET operations a single leaf may call without consent, keyed by its command path. */
const LEAF_CONSENT_FREE_OPERATIONS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "notebooks pull",
    new Map([["v2-create-notebook", "creates remote notebooks only after an interactive choice"]]),
  ],
]);

const isConsentFree = (path: string, operationId: string) =>
  CONSENT_FREE_OPERATIONS.has(operationId) ||
  LEAF_CONSENT_FREE_OPERATIONS.get(path)?.has(operationId) === true;

const MUTATING_VERBS: ReadonlySet<string> = new Set([
  "create",
  "delete",
  "remove",
  "update",
  "set",
  "unset",
  "deploy",
  "push",
  "restore",
  "activate",
  "disable",
  "pause",
  "unpause",
  "add",
  "up",
  "down",
  "squash",
  "repair",
  "reset",
  "query",
  "cp",
  "mv",
  "rm",
  "buckets",
]);

const TARGET_SELECTOR_FLAGS = ["local", "linked", "db-url"] as const;

interface Leaf {
  readonly path: string;
  readonly node: TreeNode;
  readonly policy: TargetPolicyShape;
}

const leavesByVariant = VARIANTS.map(({ name, variant }) => {
  const tree = commandTreeFor(variant);
  const leaves = [...tree].filter(([, node]) => node.isLeaf);
  return {
    name,
    withPolicy: leaves.flatMap(([path, node]): ReadonlyArray<Leaf> => {
      const policy = readTargetPolicy(node.command);
      return Option.isSome(policy) ? [{ path, node, policy: policy.value }] : [];
    }),
    missingPolicy: leaves
      .filter(([, node]) => Option.isNone(readTargetPolicy(node.command)))
      .map(([path]) => path),
  };
});

const lastWord = (path: string) => path.split(" ").at(-1) ?? path;

describe.each(leavesByVariant)(
  "target policy tree guards ($name)",
  ({ withPolicy, missingPolicy }) => {
    it("declares a target policy on every leaf", () => {
      expect(missingPolicy).toEqual([]);
    });

    it("gives local-only, account and hosted leaves no local, linked or db-url flag", () => {
      const offenders = withPolicy
        .filter(({ policy }) => ["local-only", "account", "hosted"].includes(policy.group))
        .flatMap(({ path, node }) =>
          TARGET_SELECTOR_FLAGS.filter((flag) => node.flags.has(flag)).map(
            (flag) => `${path} --${flag}`,
          ),
        );
      expect(offenders).toEqual([]);
    });

    it("gives selectable leaves remote, local, linked and project-ref flags", () => {
      const offenders = withPolicy
        .filter(({ policy }) => policy.group === "selectable")
        .flatMap(({ path, node }) =>
          (["remote", "local", "linked", "project-ref"] as const)
            .filter((flag) => !node.flags.has(flag))
            .map((flag) => `${path} lacks --${flag}`),
        );
      expect(offenders).toEqual([]);
    });

    it("requires consent for every declared non-GET operation outside the consent-free map", () => {
      const offenders = withPolicy
        .filter(({ policy }) => policy.consent === "none")
        .flatMap(({ path, node }) => {
          const permissions = Option.getOrUndefined(readPermissions(node.command));
          if (permissions?.status !== "mapped") return [];
          return permissions.operations
            .filter(
              ({ operationId }) =>
                OPERATIONS.get(operationId)?.method !== "GET" && !isConsentFree(path, operationId),
            )
            .map(({ operationId }) => `${path}: ${operationId}`);
        });
      expect([...new Set(offenders)]).toEqual([]);
    });

    it("requires an exemption reason on a selectable leaf that never asks for consent", () => {
      const offenders = withPolicy
        .filter(({ policy }) => policy.group === "selectable")
        .filter(
          ({ policy }) =>
            policy.consent === "none" && (policy.consentExemptReason ?? "").trim() === "",
        )
        .map(({ path }) => path);
      expect(offenders).toEqual([]);
    });

    it("gives every leaf-scoped consent-free operation a leaf that declares its reason", () => {
      const reasonByPath = new Map(withPolicy.map(({ path, policy }) => [path, policy]));
      const offenders = [...LEAF_CONSENT_FREE_OPERATIONS.keys()].filter((path) => {
        const policy = reasonByPath.get(path);
        return (
          policy === undefined ||
          policy.consent !== "none" ||
          (policy.consentExemptReason ?? "").trim() === ""
        );
      });
      expect(offenders).toEqual([]);
    });

    it("requires consent or an exemption reason on a leaf named for a mutating verb", () => {
      const offenders = withPolicy
        .filter(({ path }) => MUTATING_VERBS.has(lastWord(path)))
        .filter(
          ({ policy }) =>
            policy.consent === "none" && (policy.consentExemptReason ?? "").trim() === "",
        )
        .map(({ path }) => path);
      expect(offenders).toEqual([]);
    });
  },
);

describe("target policy allowlists", () => {
  it("name only operations in the API spec", () => {
    const unknown = [
      ...CONSENT_FREE_OPERATIONS.keys(),
      ...[...LEAF_CONSENT_FREE_OPERATIONS.values()].flatMap((operations) => [...operations.keys()]),
    ].filter((operationId) => !OPERATIONS.has(operationId));
    expect(unknown).toEqual([]);
  });
});

const silentFormatter: CliOutput.Formatter = {
  formatCliError: () => "",
  formatError: () => "",
  formatErrors: () => "",
  formatHelpDoc: () => "",
  formatVersion: () => "",
};

const runtimeLayer = Layer.mergeAll(BunServices.layer, CliOutput.layer(silentFormatter));

class GroupProbe extends Context.Service<GroupProbe, TargetGroup>()("test/GroupProbe") {}

describe("withTargetPolicy", () => {
  it("annotates the command with the declared policy", () => {
    const leaf = Command.make("leaf").pipe(withTargetPolicy({ group: "hosted", consent: "no" }));
    expect(readTargetPolicy(leaf)).toEqual(Option.some({ group: "hosted", consent: "no" }));
  });

  it("requires a reason from a selectable declaration that never asks for consent", () => {
    // @ts-expect-error a leaf that can reach a hosted database must say why it never asks
    withTargetPolicy({ group: "selectable", consent: "none" });
    withTargetPolicy({ group: "selectable", consent: "none", consentExemptReason: "read-only" });
    withTargetPolicy({ group: "hosted", consent: "none" });
  });

  it("reads no policy from an unannotated command", () => {
    expect(readTargetPolicy(Command.make("leaf"))).toEqual(Option.none());
  });

  it.effect("provides the policy to the handler", () =>
    Effect.gen(function* () {
      const seen: Array<TargetPolicyShape> = [];
      const leaf = Command.make("leaf").pipe(
        Command.withHandler(() =>
          Effect.gen(function* () {
            seen.push(yield* TargetPolicy);
          }),
        ),
        withTargetPolicy({ group: "selectable", consent: "yes" }),
      );
      yield* Command.runWith(leaf, { version: "0.0.0-test" })([]).pipe(
        Effect.provide(runtimeLayer),
      );
      expect(seen).toEqual([{ group: "selectable", consent: "yes" }]);
    }),
  );

  it.effect("provides the policy to layers applied before it", () =>
    Effect.gen(function* () {
      const probeLayer = Layer.effect(
        GroupProbe,
        Effect.gen(function* () {
          return (yield* TargetPolicy).group;
        }),
      );
      const seen: Array<TargetGroup> = [];
      const leaf = Command.make("leaf").pipe(
        Command.withHandler(() =>
          Effect.gen(function* () {
            seen.push(yield* GroupProbe);
          }),
        ),
        Command.provide(probeLayer),
        withTargetPolicy({ group: "account", consent: "none" }),
      );
      yield* Command.runWith(leaf, { version: "0.0.0-test" })([]).pipe(
        Effect.provide(runtimeLayer),
      );
      expect(seen).toEqual(["account"]);
    }),
  );
});
