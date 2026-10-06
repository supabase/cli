import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { rootCommandForFeatures } from "../../cli/root.ts";
import { userGlobalFlagParams } from "../../docs/docs-introspection.ts";
import { commandTreeFor, flagNames } from "../../../tests/helpers/command-flags.ts";
import type { TreeNode } from "../../../tests/helpers/command-flags.ts";
import { OPERATIONS } from "../../../tests/helpers/operation-table.ts";
import { readPermissions } from "./command-permissions.annotation.ts";
import { GLOBAL_NO_API_EFFECT_FLAGS } from "./global-flags.ts";
import type { CommandPermissions, FlagCondition, OperationEntry } from "./model.ts";
import { PENDING_COMMANDS } from "./pending-commands.ts";
import type { PermissionVariant } from "./registry.ts";

/**
 * Whole-command Go delegation, per `docs/go-cli-porting-status.md`. Flag-gated delegation
 * (`db diff --use-pg-schema`, `functions download --legacy-bundle`) stays mapped with a
 * `context` note instead.
 */
const GO_DELEGATED_PATHS: ReadonlySet<string> = new Set([
  "db branch create",
  "db branch delete",
  "db branch list",
  "db branch switch",
  "db remote changes",
  "gen keys",
]);

const VARIANTS: ReadonlyArray<{ readonly name: string; readonly variant: PermissionVariant }> = [
  { name: "default backend", variant: undefined },
  {
    name: "stack backend",
    // Sets every option, so a new option added to `rootCommandForFeatures` is a type error here.
    variant: { stackBackend: "stack", computeEnabled: true } satisfies Required<
      NonNullable<PermissionVariant>
    >,
  },
];

function rootGlobalFlagIds(): ReadonlySet<string> {
  return new Set(flagNames(userGlobalFlagParams(rootCommandForFeatures())));
}

function conditionFlagNames(entries: ReadonlyArray<OperationEntry>): ReadonlyArray<string> {
  return entries.flatMap((entry) => (entry.when ?? []).map((cond: FlagCondition) => cond.flag));
}

function declarationOf(node: TreeNode): CommandPermissions | undefined {
  return Option.getOrUndefined(readPermissions(node.command));
}

describe("command permission mapping completeness", () => {
  const trees = VARIANTS.map(({ name, variant }) => ({ name, tree: commandTreeFor(variant) }));
  const everyLeafPath = new Set(
    trees.flatMap(({ tree }) => [...tree].filter(([, node]) => node.isLeaf).map(([path]) => path)),
  );
  const everyRealFlag = new Set(
    trees.flatMap(({ tree }) => [...tree.values()].flatMap((node) => [...node.flags])),
  );
  const pendingPaths = new Set(PENDING_COMMANDS);

  it("lists every pending path once, and only paths that are real leaves", () => {
    expect(pendingPaths.size, "PENDING_COMMANDS has a duplicate entry").toBe(
      PENDING_COMMANDS.length,
    );
    for (const path of pendingPaths) {
      expect(
        everyLeafPath.has(path),
        `pending path "${path}" is not a leaf in any command tree`,
      ).toBe(true);
    }
  });

  for (const { name, tree } of trees) {
    describe(name, () => {
      const leaves = [...tree].filter(([, node]) => node.isLeaf);

      it("declares or pends every leaf, never both", () => {
        for (const [path, node] of leaves) {
          const isDeclared = declarationOf(node) !== undefined;
          const isPending = pendingPaths.has(path);
          expect(isDeclared || isPending, `"${path}" is neither declared nor pending`).toBe(true);
          expect(
            isDeclared && isPending,
            `"${path}" is both declared and pending — remove it from PENDING_COMMANDS`,
          ).toBe(false);
        }
      });

      it("declares permissions only on leaf commands", () => {
        for (const [path, node] of tree) {
          if (node.isLeaf) continue;
          expect(
            declarationOf(node),
            `"${path}" is a command group; declare permissions on its leaves instead`,
          ).toBeUndefined();
        }
      });

      it("classifies every flag a mapped leaf accepts, and only references flags that exist", () => {
        const globalFlags = new Set(GLOBAL_NO_API_EFFECT_FLAGS);

        for (const [path, node] of leaves) {
          const permissions = declarationOf(node);
          if (permissions?.status !== "mapped") continue;

          const classified = new Set([
            ...globalFlags,
            ...permissions.noApiEffectFlags,
            ...conditionFlagNames(permissions.operations),
          ]);

          for (const flag of node.flags) {
            expect(
              classified.has(flag),
              `"${path}" accepts --${flag}, which is not classified`,
            ).toBe(true);
          }
          // `noApiEffectFlags` has no per-entry provenance, so it's checked against every flag the
          // real CLI has anywhere, not just this command's own — a building block can legitimately
          // contribute a flag name here that only some of its consuming commands accept.
          for (const flag of permissions.noApiEffectFlags) {
            expect(
              everyRealFlag.has(flag),
              `"${path}"'s noApiEffectFlags names "--${flag}", which no real CLI command accepts`,
            ).toBe(true);
          }
          for (const entry of permissions.operations) {
            for (const cond of entry.when ?? []) {
              // A command's own entry must name one of its own flags. An entry a building block
              // contributed (`entry.source` set) only has to name a real flag somewhere in the CLI:
              // a command can include a block without accepting every flag its conditions mention.
              // On such a command a presence condition is false and an absence condition holds
              // (see `model.ts`'s `block`).
              const validNames = entry.source === undefined ? node.flags : everyRealFlag;
              expect(
                validNames.has(cond.flag),
                `"${path}"'s \`when\` condition on "${entry.operationId}" names "--${cond.flag}", which doesn't exist${entry.source === undefined ? "" : ` (from building block "${entry.source}")`}`,
              ).toBe(true);
            }
          }
        }
      });

      it("references only operationIds that exist in the bundled spec", () => {
        for (const [path, node] of leaves) {
          const permissions = declarationOf(node);
          if (permissions?.status !== "mapped") continue;
          for (const entry of permissions.operations) {
            expect(
              OPERATIONS.has(entry.operationId),
              `"${path}" declares operationId "${entry.operationId}", which the bundled spec does not have`,
            ).toBe(true);
          }
        }
      });

      it("only marks a leaf unmapped when it's on the known go-delegation allowlist", () => {
        for (const [path, node] of leaves) {
          const permissions = declarationOf(node);
          if (permissions?.status !== "unmapped") continue;
          expect(
            GO_DELEGATED_PATHS.has(path),
            `"${path}" is declared unmapped (${permissions.reason}), but isn't on the go-delegation allowlist — add it there if docs/go-cli-porting-status.md confirms it, otherwise map it`,
          ).toBe(true);
        }
      });
    });
  }

  it("matches the global flag table against the root command's actual global flags exactly", () => {
    expect(new Set(GLOBAL_NO_API_EFFECT_FLAGS)).toEqual(rootGlobalFlagIds());
    expect(
      GLOBAL_NO_API_EFFECT_FLAGS.length,
      "GLOBAL_NO_API_EFFECT_FLAGS has a duplicate entry",
    ).toBe(new Set(GLOBAL_NO_API_EFFECT_FLAGS).size);
  });
});
