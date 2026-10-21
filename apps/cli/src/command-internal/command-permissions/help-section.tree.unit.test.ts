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

      // Help lists only visible flags of a parent group, but the command's own flags come with
      // their hidden ones from what `withPermissions` recorded.
      const catalogFor = (path: string): FlagCatalog => {
        const parts = path.split(" ");
        const inherited = parts.slice(0, -1).flatMap((_, index) => {
          const ancestor = tree.get(parts.slice(0, index + 1).join(" "));
          return ancestor === undefined
            ? []
            : permissionFlagsOf(ownParams(ancestor.command)).filter((flag) => !flag.hidden);
        });
        const own = tree.get(path);
        const ownFlags = own === undefined ? [] : permissionFlagsOf(ownParams(own.command));
        return new Map([...rootFlags, ...inherited, ...ownFlags].map((flag) => [flag.name, flag]));
      };

      const paramsFor = (path: string) => {
        const parts = path.split(" ");
        return new Map(
          [
            ...userGlobalFlagParams(rootCommandForFeatures(variant)),
            ...parts.flatMap((_, index) => {
              const ancestor = tree.get(parts.slice(0, index + 1).join(" "));
              return ancestor === undefined ? [] : ownParams(ancestor.command);
            }),
          ].map((param) => [unwrapParam(param)?.single.name, param] as const),
        );
      };

      it("gives a flag a default only when parsing no arguments yields that value", async () => {
        for (const [path, node] of leaves) {
          const declared = Option.getOrUndefined(readPermissions(node.command));
          if (declared?.status !== "mapped") continue;
          const params = paramsFor(path);
          // Help rebuilds a parent group's flags without defaults, so only these carry one.
          const known = new Map(
            [...rootFlags, ...permissionFlagsOf(ownParams(node.command))].map((flag) => [
              flag.name,
              flag,
            ]),
          );
          const tested = new Set(
            declared.operations.flatMap((entry) =>
              (entry.when ?? []).flatMap((condition) =>
                condition.oneOf === undefined ? [] : [condition.flag],
              ),
            ),
          );
          for (const flag of tested) {
            const param = params.get(flag);
            if (flag === undefined || param === undefined) continue;
            const exit = await Effect.runPromiseExit(
              param.parse({ flags: {}, arguments: [] }).pipe(Effect.provide(BunServices.layer)),
            );
            const parsed = Exit.isSuccess(exit) ? exit.value[1] : undefined;
            expect(
              known.get(flag)?.default,
              `"${path}" --${flag} default differs from parsing no arguments`,
            ).toBe(typeof parsed === "string" ? parsed : undefined);
          }
        }
      });

      it("never turns on by default a switch a condition tests", async () => {
        for (const [path, node] of leaves) {
          const declared = Option.getOrUndefined(readPermissions(node.command));
          if (declared?.status !== "mapped") continue;
          const params = paramsFor(path);
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
            Option.match(recorded, { onNone: () => [], onSome: (read) => read() }).map(
              (flag) => flag.name,
            ),
            `"${path}" declares permissions before its flags are complete`,
          ).toEqual(expected);
        }
      });

      // Help sees a parent group's flags only as visible names, so a condition cannot depend on
      // a parent's hidden flag or on its choice values.
      it("only conditions on flags a parent group shares when help can describe them", () => {
        for (const [path, node] of leaves) {
          const declared = Option.getOrUndefined(readPermissions(node.command));
          if (declared?.status !== "mapped") continue;
          const parts = path.split(" ");
          const own = new Set(permissionFlagsOf(ownParams(node.command)).map((flag) => flag.name));
          const root = new Set(rootFlags.map((flag) => flag.name));
          const inherited = new Map(
            parts
              .slice(0, -1)
              .flatMap((_, index) => {
                const ancestor = tree.get(parts.slice(0, index + 1).join(" "));
                return ancestor === undefined ? [] : permissionFlagsOf(ownParams(ancestor.command));
              })
              .map((flag) => [flag.name, flag]),
          );
          for (const entry of declared.operations) {
            for (const condition of entry.when ?? []) {
              const flag = condition.flag === undefined ? undefined : inherited.get(condition.flag);
              if (flag === undefined || own.has(flag.name) || root.has(flag.name)) continue;
              expect(
                !flag.hidden && flag.kind !== "choice",
                `"${path}" conditions on --${flag.name}, a hidden or choice flag of a parent group that help cannot describe`,
              ).toBe(true);
            }
          }
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

      it("prints each heading once, and never lists a row as both required and optional", () => {
        for (const [path, node] of leaves) {
          const declared = Option.getOrUndefined(readPermissions(node.command));
          if (declared === undefined) continue;
          const section = resolvePermissionSection(declared, catalogFor(path));
          if (section?.status !== "mapped") continue;
          for (const scheme of section.schemes) {
            const headings = scheme.groups.map((group) => group.heading);
            expect(new Set(headings).size, `"${path}" repeats a heading`).toBe(headings.length);
            const rowsOf = (matches: (need: string) => boolean) =>
              scheme.groups
                .filter((group) => matches(group.need))
                .flatMap((group) => group.rows.map((row) => JSON.stringify(row)));
            const required = new Set(rowsOf((need) => need !== "optional"));
            for (const row of rowsOf((need) => need === "optional")) {
              expect(required.has(row), `"${path}" lists ${row} as required and optional`).toBe(
                false,
              );
            }
          }
        }
      });
    });
  }
});
