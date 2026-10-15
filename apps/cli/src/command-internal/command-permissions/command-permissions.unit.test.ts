import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { rootCommandForFeatures } from "../../cli/root.ts";
import { userGlobalFlagParams } from "../../docs/docs-introspection.ts";
import { commandTreeFor, flagNames } from "../../../tests/helpers/command-flags.ts";
import type { TreeNode } from "../../../tests/helpers/command-flags.ts";
import { OPERATIONS } from "../../../tests/helpers/operation-table.ts";
import { readPermissions } from "./command-permissions.annotation.ts";
import { GLOBAL_NO_API_EFFECT_FLAGS } from "../../../tests/helpers/permission-global-flags.ts";
import type { CommandPermissions, EntryCondition, OperationEntry } from "./model.ts";
import { DB_TARGET_FLAGS } from "../../../tests/helpers/permission-registry.ts";
import type { PermissionVariant } from "../../../tests/helpers/permission-registry.ts";

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

/**
 * Operations a declaration may reference although the spec gives them no `x-fga-permissions`,
 * keyed by `operationId` with the reason. A missing extension otherwise fails the test, since it
 * doesn't say whether a scoped token can call the operation.
 */
const OPERATIONS_WITHOUT_FGA: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "v1-get-profile",
    "returns the caller's own profile; the spec declares no FGA permission for it",
  ],
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
  return entries.flatMap((entry) =>
    (entry.when ?? []).flatMap((cond: EntryCondition) =>
      cond.dbTarget === undefined ? [cond.flag] : DB_TARGET_FLAGS,
    ),
  );
}

function declarationOf(node: TreeNode): CommandPermissions | undefined {
  return Option.getOrUndefined(readPermissions(node.command));
}

describe("command permission mapping completeness", () => {
  const trees = VARIANTS.map(({ name, variant }) => ({ name, tree: commandTreeFor(variant) }));
  const everyRealFlag = new Set(
    trees.flatMap(({ tree }) => [...tree.values()].flatMap((node) => [...node.flags])),
  );

  for (const { name, tree } of trees) {
    describe(name, () => {
      const leaves = [...tree].filter(([, node]) => node.isLeaf);

      it("declares permissions on every leaf", () => {
        for (const [path, node] of leaves) {
          expect(declarationOf(node), `"${path}" declares no permissions`).toBeDefined();
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
              if (cond.dbTarget !== undefined) {
                const where = `"${path}"'s \`when\` condition on "${entry.operationId}"`;
                expect(
                  permissions.dbTargetDefault,
                  `${where} checks the database target, but the declaration sets no default — wrap it in withDbTarget`,
                ).toBeDefined();
                // A block's condition may name a target the command can't select; a command's own must be reachable.
                for (const target of cond.source === undefined ? cond.dbTarget : []) {
                  expect(
                    target === permissions.dbTargetDefault || node.flags.has(target),
                    `${where} names the "${target}" target, which --${target} can't select and isn't the default`,
                  ).toBe(true);
                }
                continue;
              }
              // A condition a building block wrote (`cond.source` set) only has to name a real flag
              // somewhere in the CLI: a command can include a block without accepting every flag
              // its conditions mention. On such a command a presence condition is false and an
              // absence condition holds. Every other condition must name this command's own flag.
              const validNames = cond.source === undefined ? node.flags : everyRealFlag;
              expect(
                validNames.has(cond.flag),
                `"${path}"'s \`when\` condition on "${entry.operationId}" names "--${cond.flag}", which doesn't exist${cond.source === undefined ? "" : ` (from building block "${cond.source}")`}`,
              ).toBe(true);
              const info = node.flagInfo.get(cond.flag);
              const where = `"${path}"'s \`when\` condition on "${entry.operationId}"`;
              if (cond.is !== undefined && info !== undefined) {
                expect(
                  info.isBoolean,
                  `${where} tests --${cond.flag} with \`is\`, but it takes a value — use \`oneOf\``,
                ).toBe(true);
                expect(
                  info.isOptional,
                  `${where} tests --${cond.flag} with \`is\`, but it is optional, so "not given" differs from "false" — use \`present\``,
                ).toBe(false);
              }
              if (cond.is === undefined && cond.oneOf === undefined && info?.isBoolean === true) {
                expect(
                  info.isOptional,
                  `${where} tests --${cond.flag} by presence, but it has a default and is always present — use \`is\``,
                ).toBe(true);
              }
              if (cond.oneOf === undefined || info === undefined) continue;
              expect(
                cond.oneOf.length,
                `${where} lists no values for --${cond.flag}`,
              ).toBeGreaterThan(0);
              expect(
                info.isBoolean,
                `${where} checks the value of --${cond.flag}, a switch with no value — use \`is\` or \`present\``,
              ).toBe(false);
              for (const value of cond.oneOf) {
                expect(
                  info.choices === undefined || info.choices.includes(value),
                  `${where} lists "${value}", which --${cond.flag} doesn't accept (${info.choices?.join(", ")})`,
                ).toBe(true);
              }
            }
          }
        }
      });

      it("references only operationIds that exist in the bundled spec and declare FGA permissions", () => {
        for (const [path, node] of leaves) {
          const permissions = declarationOf(node);
          if (permissions?.status !== "mapped") continue;
          for (const entry of permissions.operations) {
            const operation = OPERATIONS.get(entry.operationId);
            expect(
              operation,
              `"${path}" declares operationId "${entry.operationId}", which the bundled spec does not have`,
            ).toBeDefined();
            expect(
              operation?.fga !== undefined || OPERATIONS_WITHOUT_FGA.has(entry.operationId),
              `"${path}" declares "${entry.operationId}", which has no x-fga-permissions in the bundled spec — add it to OPERATIONS_WITHOUT_FGA with the reason`,
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

  it("acknowledges only operations that really lack x-fga-permissions in the bundled spec", () => {
    for (const operationId of OPERATIONS_WITHOUT_FGA.keys()) {
      const operation = OPERATIONS.get(operationId);
      expect(operation, `OPERATIONS_WITHOUT_FGA names unknown "${operationId}"`).toBeDefined();
      expect(
        operation?.fga,
        `"${operationId}" now has x-fga-permissions — remove it from OPERATIONS_WITHOUT_FGA`,
      ).toBeUndefined();
    }
  });

  it("matches the global flag table against the root command's actual global flags exactly", () => {
    expect(new Set(GLOBAL_NO_API_EFFECT_FLAGS)).toEqual(rootGlobalFlagIds());
    expect(
      GLOBAL_NO_API_EFFECT_FLAGS.length,
      "GLOBAL_NO_API_EFFECT_FLAGS has a duplicate entry",
    ).toBe(new Set(GLOBAL_NO_API_EFFECT_FLAGS).size);
  });
});
