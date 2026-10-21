import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Exit, Option } from "effect";
import type { Command } from "effect/cli";
import { describe, expect, it } from "vitest";

import { commandTreeFor } from "../../../tests/helpers/command-flags.ts";
import type { PermissionVariant } from "../../../tests/helpers/permission-registry.ts";
import { commandInternals, userGlobalFlagParams } from "../../docs/docs-introspection.ts";
import { readPermissions } from "./command-permissions.annotation.ts";
import { renderPermissionsSection, resolvePermissionSection } from "./help-section.ts";
import { CommandFlagsAnnotation, permissionFlagsOf } from "./permission-flags.ts";
import type { FlagCatalog } from "./permission-flags.ts";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { unwrapParam } from "../param-introspection.ts";

const VARIANTS: ReadonlyArray<{ readonly name: string; readonly variant: PermissionVariant }> = [
  { name: "default backend", variant: undefined },
  {
    name: "stack backend",
    variant: {
      projectState: Exit.succeed("stack"),
      stackBackend: "stack",
      computeEnabled: true,
    } satisfies Required<NonNullable<PermissionVariant>>,
  },
];

const ownParams = (command: Command.Command.Any) => {
  const internals = commandInternals(command);
  return [
    ...internals.config.flags,
    ...internals.contextConfig.flags,
    ...userGlobalFlagParams(command),
  ];
};

describe("permission help section across the command tree", () => {
  for (const { name, variant } of VARIANTS) {
    describe(name, () => {
      const tree = commandTreeFor(variant);
      const rootFlags = permissionFlagsOf(userGlobalFlagParams(rootCommandForFeatures(variant)));
      const leaves = [...tree].filter(([, node]) => node.isLeaf);

      const catalogFor = (path: string): FlagCatalog => {
        const parts = path.split(" ");
        const params = parts.flatMap((_, index) => {
          const ancestor = tree.get(parts.slice(0, index + 1).join(" "));
          return ancestor === undefined ? [] : ownParams(ancestor.command);
        });
        return new Map(
          [...rootFlags, ...permissionFlagsOf(params)].map((flag) => [flag.name, flag]),
        );
      };

      it("never turns on by default a switch a condition tests", async () => {
        for (const [path, node] of leaves) {
          const declared = Option.getOrUndefined(readPermissions(node.command));
          if (declared?.status !== "mapped") continue;
          const parts = path.split(" ");
          const params = new Map(
            [
              ...userGlobalFlagParams(rootCommandForFeatures(variant)),
              ...parts.flatMap((_, index) => {
                const ancestor = tree.get(parts.slice(0, index + 1).join(" "));
                return ancestor === undefined ? [] : ownParams(ancestor.command);
              }),
            ].map((param) => [unwrapParam(param)?.single.name, param] as const),
          );
          const tested = new Set(
            declared.operations.flatMap((entry) =>
              (entry.when ?? []).flatMap((condition) =>
                condition.is === undefined ? [] : [condition.flag],
              ),
            ),
          );
          for (const flag of tested) {
            const param = params.get(flag);
            if (param === undefined || catalogFor(path).get(flag)?.hidden !== false) continue;
            const [, value] = await Effect.runPromise(
              param.parse({ flags: {}, arguments: [] }).pipe(Effect.provide(BunServices.layer)),
            );
            expect(value, `"${path}" --${flag} defaults to on`).not.toBe(true);
          }
        }
      });

      it("records every flag a command accepts when it declares its permissions", () => {
        for (const [path, node] of leaves) {
          const recorded = Context.getOption(node.command.annotations, CommandFlagsAnnotation);
          const expected = permissionFlagsOf(ownParams(node.command)).map((flag) => flag.name);
          expect(Option.isSome(recorded), `"${path}" records no flags`).toBe(true);
          expect(
            Option.getOrElse(recorded, () => []).map((flag) => flag.name),
            `"${path}" declares permissions before its flags are complete`,
          ).toEqual(expected);
        }
      });

      it("renders a section for every command that calls an API operation", () => {
        for (const [path, node] of leaves) {
          const declared = Option.getOrUndefined(readPermissions(node.command));
          if (declared === undefined) continue;
          const section = resolvePermissionSection(declared, catalogFor(path));
          const callsApi = declared.status === "unmapped" || declared.operations.length > 0;
          expect(section === undefined, `"${path}" section presence`).toBe(!callsApi);
          if (section?.status !== "mapped") continue;
          for (const scheme of section.schemes) {
            expect(
              scheme.groups.length,
              `"${path}" has an empty ${scheme.scheme} block`,
            ).toBeGreaterThan(0);
            for (const group of scheme.groups) {
              expect(
                group.rows.length,
                `"${path}" "${group.heading}" lists no rows`,
              ).toBeGreaterThan(0);
            }
          }
        }
      });

      it("names only flags the command shows in its help", () => {
        for (const [path, node] of leaves) {
          const declared = Option.getOrUndefined(readPermissions(node.command));
          if (declared === undefined) continue;
          const catalog = catalogFor(path);
          const section = resolvePermissionSection(declared, catalog);
          if (section === undefined) continue;
          const text = renderPermissionsSection(section);
          for (const [, flag] of text.matchAll(/--([a-z][a-z0-9-]*)/g)) {
            expect(
              flag !== undefined && catalog.get(flag)?.hidden === false,
              `"${path}" section names --${flag}, which its help does not show`,
            ).toBe(true);
          }
        }
      });

      it("prints each heading once", () => {
        for (const [path, node] of leaves) {
          const declared = Option.getOrUndefined(readPermissions(node.command));
          if (declared === undefined) continue;
          const section = resolvePermissionSection(declared, catalogFor(path));
          if (section?.status !== "mapped") continue;
          for (const scheme of section.schemes) {
            const headings = scheme.groups.map((group) => group.heading);
            expect(new Set(headings).size, `"${path}" repeats a heading`).toBe(headings.length);
          }
        }
      });
    });
  }
});
