import { describe, expect, it } from "vitest";
import type { Command } from "effect/unstable/cli";

import { rootCommandForFeatures } from "../../cli/root.ts";
import {
  commandInternals,
  flattenSubcommands,
  userGlobalFlagParams,
} from "../../docs/docs-introspection.ts";
import { unwrapToSingleParam } from "../param-introspection.ts";
import { OPERATIONS } from "../../../tests/helpers/operation-table.ts";
import { COMMAND_PERMISSIONS, PENDING_COMMANDS, PERMISSION_GROUPS } from "./index.ts";
import { GLOBAL_NO_API_EFFECT_FLAGS } from "./global-flags.ts";
import type { FlagCondition, OperationEntry } from "./model.ts";

/** Walks the real command tree so this test fails the moment a command, flag, or operation reference drifts. */

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

function flagNames(params: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return (params as Array<Parameters<typeof unwrapToSingleParam>[0]>).map((param) => {
    const name = unwrapToSingleParam(param)?.name;
    if (name === undefined) {
      throw new Error(
        "command-permissions.unit.test.ts: a flag param wraps an unrecognized Param variant — effect's Param union may have changed.",
      );
    }
    return name;
  });
}

/** A command's own flags: its `config.flags` plus whatever it registers via `withGlobalFlags` (e.g. `seed`'s persistent `--linked`/`--local`), which never appear in `config.flags`. */
function ownFlagsOf(command: Command.Command.Any): ReadonlyArray<string> {
  const internals = commandInternals(command);
  return [...flagNames(internals.config.flags), ...flagNames(userGlobalFlagParams(command))];
}

function walk(
  command: Command.Command.Any,
  path: ReadonlyArray<string>,
  inherited: ReadonlyArray<string>,
  out: Map<string, Set<string>>,
): void {
  const ownFlags = ownFlagsOf(command);
  const children = flattenSubcommands(command);
  if (children.length === 0) {
    const key = path.join(" ");
    const flags = out.get(key) ?? new Set<string>();
    for (const flag of [...inherited, ...ownFlags]) flags.add(flag);
    out.set(key, flags);
    return;
  }
  for (const child of children) {
    walk(child, [...path, child.name], [...inherited, ...ownFlags], out);
  }
}

function realLeaves(): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const root of [
    rootCommandForFeatures(),
    rootCommandForFeatures({ stackBackend: "stack", computeEnabled: true }),
  ]) {
    // The root's own global flags (`--output`, `--debug`, …) apply to every command but never
    // appear on any child node, so they seed the walk instead of being discovered by it.
    const rootFlags = ownFlagsOf(root);
    for (const child of flattenSubcommands(root)) {
      walk(child, [child.name], rootFlags, out);
    }
  }
  return out;
}

function rootGlobalFlagIds(): ReadonlySet<string> {
  return new Set(flagNames(userGlobalFlagParams(rootCommandForFeatures())));
}

function conditionFlagNames(entries: ReadonlyArray<OperationEntry>): ReadonlyArray<string> {
  return entries.flatMap((entry) => (entry.when ?? []).map((cond: FlagCondition) => cond.flag));
}

describe("command permission mapping completeness", () => {
  const leaves = realLeaves();
  const everyRealFlag = new Set([...leaves.values()].flatMap((flags) => [...flags]));

  it("has at least one leaf for every registered permission group, and no group for a nonexistent one", () => {
    const groupsWithLeaves = new Set([...leaves.keys()].map((path) => path.split(" ")[0]!));
    for (const group of PERMISSION_GROUPS.keys()) {
      expect(
        groupsWithLeaves.has(group),
        `group "${group}" has no leaf in the real command tree`,
      ).toBe(true);
    }
    for (const group of groupsWithLeaves) {
      expect(PERMISSION_GROUPS.has(group), `group "${group}" has no permissions file`).toBe(true);
    }
  });

  it("declares or pends every real leaf exactly once, with no entry for a path that doesn't exist", () => {
    const declaredPaths = new Set(COMMAND_PERMISSIONS.keys());
    const pendingPaths = new Set(PENDING_COMMANDS);

    expect(pendingPaths.size, "PENDING_COMMANDS has a duplicate entry").toBe(
      PENDING_COMMANDS.length,
    );

    for (const path of leaves.keys()) {
      const isDeclared = declaredPaths.has(path);
      const isPending = pendingPaths.has(path);
      expect(isDeclared || isPending, `"${path}" is neither declared nor pending`).toBe(true);
      expect(isDeclared && isPending, `"${path}" is both declared and pending`).toBe(false);
    }

    for (const path of declaredPaths) {
      expect(
        leaves.has(path),
        `declared path "${path}" does not exist in the real command tree`,
      ).toBe(true);
    }
    for (const path of pendingPaths) {
      expect(
        leaves.has(path),
        `pending path "${path}" does not exist in the real command tree`,
      ).toBe(true);
    }
  });

  it("matches the global flag table against the root command's actual global flags exactly", () => {
    expect(new Set(GLOBAL_NO_API_EFFECT_FLAGS)).toEqual(rootGlobalFlagIds());
    expect(
      GLOBAL_NO_API_EFFECT_FLAGS.length,
      "GLOBAL_NO_API_EFFECT_FLAGS has a duplicate entry",
    ).toBe(new Set(GLOBAL_NO_API_EFFECT_FLAGS).size);
  });

  it("only marks a command unmapped when it's on the known go-delegation allowlist", () => {
    for (const [path, permissions] of COMMAND_PERMISSIONS) {
      if (permissions.status !== "unmapped") continue;
      expect(
        GO_DELEGATED_PATHS.has(path),
        `"${path}" is declared unmapped (${permissions.reason}), but isn't on the go-delegation allowlist — add it there if docs/go-cli-porting-status.md confirms it, otherwise map it`,
      ).toBe(true);
    }
  });

  it("classifies every flag a mapped command accepts, and only references flags that exist", () => {
    const globalFlags = new Set(GLOBAL_NO_API_EFFECT_FLAGS);

    for (const [path, permissions] of COMMAND_PERMISSIONS) {
      if (permissions.status !== "mapped") continue;
      const realFlags = leaves.get(path);
      expect(
        realFlags,
        `"${path}" is declared but has no matching real command leaf`,
      ).toBeDefined();

      const classified = new Set([
        ...globalFlags,
        ...permissions.noApiEffectFlags,
        ...conditionFlagNames(permissions.operations),
      ]);

      for (const flag of realFlags!) {
        expect(classified.has(flag), `"${path}" accepts --${flag}, which is not classified`).toBe(
          true,
        );
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
          // some commands include a block without accepting every flag the block's conditions
          // mention, and the condition simply never applies to them (see `model.ts`'s `block`).
          const validNames = entry.source === undefined ? realFlags! : everyRealFlag;
          expect(
            validNames.has(cond.flag),
            `"${path}"'s \`when\` condition on "${entry.operationId}" names "--${cond.flag}", which doesn't exist${entry.source === undefined ? "" : ` (from building block "${entry.source}")`}`,
          ).toBe(true);
        }
      }
    }
  });

  it("references only operationIds that exist in the bundled spec", () => {
    for (const [path, permissions] of COMMAND_PERMISSIONS) {
      if (permissions.status !== "mapped") continue;
      for (const entry of permissions.operations) {
        expect(
          OPERATIONS.has(entry.operationId),
          `"${path}" declares operationId "${entry.operationId}", which the bundled spec does not have`,
        ).toBe(true);
      }
    }
  });
});
