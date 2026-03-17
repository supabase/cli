import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import type { PlatformOperationDescriptor } from "./platform-types.ts";
import { makePlatformLeafCommand } from "./platform-command-factory.ts";
import { platformSchemaCommand } from "./platform-schema.command.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";

type TreeNode = {
  segment?: string;
  descriptor?: PlatformOperationDescriptor;
  children: Map<string, TreeNode>;
};

type PlatformCliCommand = CliCommand.Command<string, unknown, {}, never, never>;

function makeTreeNode(segment?: string): TreeNode {
  return {
    ...(segment ? { segment } : {}),
    children: new Map(),
  };
}

export function buildPlatformTree(
  descriptors: ReadonlyArray<PlatformOperationDescriptor>,
): TreeNode {
  const root = makeTreeNode();
  for (const descriptor of descriptors) {
    insertDescriptor(root, descriptor);
  }
  return root;
}

function insertDescriptor(root: TreeNode, descriptor: PlatformOperationDescriptor) {
  let current = root;
  for (const segment of descriptor.commandPath.slice(1)) {
    const existing = current.children.get(segment);
    if (existing !== undefined) {
      current = existing;
      continue;
    }
    const next = makeTreeNode(segment);
    current.children.set(segment, next);
    current = next;
  }
  current.descriptor = descriptor;
}

function humanizeSegment(segment: string): string {
  return segment
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function buildCommand(
  segment: string,
  node: TreeNode,
  path: ReadonlyArray<string>,
): PlatformCliCommand {
  if (node.descriptor !== undefined) {
    return makePlatformLeafCommand(node.descriptor);
  }

  const subcommands = [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([childSegment, childNode]) =>
      buildCommand(childSegment, childNode, [...path, childSegment]),
    );

  return Command.make(segment).pipe(
    Command.withDescription(`Platform ${path.map(humanizeSegment).join(" ")} commands.`),
    Command.withShortDescription(humanizeSegment(segment)),
    Command.withSubcommands(subcommands),
  );
}

function buildPlatformSubcommands() {
  const root = buildPlatformTree(platformOperationDescriptors);

  return [...root.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([segment, node]) => buildCommand(segment, node, [segment]));
}

export function collectPlatformTreePaths(
  node: TreeNode,
  prefix: ReadonlyArray<string> = [],
): ReadonlyArray<ReadonlyArray<string>> {
  const currentPath = node.segment ? [...prefix, node.segment] : prefix;
  const paths = node.descriptor !== undefined && currentPath.length > 0 ? [currentPath] : [];

  const childPaths = [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, child]) => collectPlatformTreePaths(child, currentPath));

  return [...paths, ...childPaths];
}

export const platformCommand: CliCommand.Command<"platform", unknown, {}, never, never> =
  Command.make("platform").pipe(
    Command.withDescription(
      "Platform Management API commands generated from @supabase/api metadata.",
    ),
    Command.withShortDescription("Platform Management API"),
    Command.withSubcommands([platformSchemaCommand, ...buildPlatformSubcommands()]),
  );
