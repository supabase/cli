import { describe, expect, it } from "vitest";

import { findCommand } from "../../docs/command-docs.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";
import { buildPlatformTree, collectPlatformTreePaths, platformCommand } from "./platform-tree.ts";

function subcommandNames(command: {
  readonly subcommands: ReadonlyArray<{
    readonly commands: ReadonlyArray<{
      readonly name: string;
    }>;
  }>;
}) {
  return command.subcommands.flatMap((group) => group.commands.map((child) => child.name));
}

describe("platform tree", () => {
  it("assembles every platform operation into a single tree without losing paths", () => {
    const tree = buildPlatformTree(platformOperationDescriptors);
    const paths = collectPlatformTreePaths(tree);

    expect(paths.map((path) => path.join("/")).sort()).toEqual(
      platformOperationDescriptors
        .map((descriptor) => descriptor.commandPath.slice(1).join("/"))
        .sort(),
    );
  });

  it("orders top-level and nested subcommands alphabetically", () => {
    const rootNames = subcommandNames(platformCommand);
    expect(rootNames[0]).toBe("schema");
    expect(rootNames.slice(1)).toEqual(rootNames.slice(1).toSorted());

    const projects = findCommand(platformCommand, ["projects"]);
    expect(projects).toBeDefined();
    const projectNames = subcommandNames(projects!);
    expect(projectNames).toEqual(projectNames.toSorted());
  });

  it("exposes normalized leaf paths in the built command tree", () => {
    expect(findCommand(platformCommand, ["oauth", "authorize"])).toBeDefined();
    expect(findCommand(platformCommand, ["branches", "diff"])).toBeDefined();
    expect(findCommand(platformCommand, ["projects", "database", "jit", "list"])).toBeDefined();
    expect(findCommand(platformCommand, ["projects", "secrets", "bulk-create"])).toBeDefined();
  });
});
