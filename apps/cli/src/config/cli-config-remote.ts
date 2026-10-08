import { Option } from "effect";

import { PROJECT_REF_PATTERN } from "./project-ref.service.ts";
import { isDocumentRecord } from "./cli-config-document.ts";
import { cliRemoteProjectIdEnvName } from "./cli-config-keys.ts";
import { expandCliConfigEnvReference } from "./cli-config-key.ts";

type EnvLookup = (name: string) => string | undefined;

const remoteBlocks = (remotes: Readonly<Record<string, unknown>>) =>
  Object.entries(remotes).map(([name, block]) => ({
    name,
    block: isDocumentRecord(block) ? block : undefined,
  }));

const literalProjectId = (block: Readonly<Record<string, unknown>> | undefined) => {
  const literal = block?.["project_id"];
  return typeof literal === "string" ? literal : undefined;
};

/** A remote's `project_id` for matching: the env override when non-empty, else the raw TOML literal. */
const matchProjectId = (
  name: string,
  block: Readonly<Record<string, unknown>> | undefined,
  lookup: EnvLookup,
) => lookup(cliRemoteProjectIdEnvName(name)) ?? literalProjectId(block);

/** The first `[remotes.<name>]` whose effective `project_id` equals the target ref. */
export const selectCliConfigRemote = (
  remotes: Readonly<Record<string, unknown>>,
  projectRef: Option.Option<string>,
  lookup: EnvLookup,
): string | undefined => {
  if (Option.isNone(projectRef)) return undefined;
  return remoteBlocks(remotes).find(
    ({ name, block }) =>
      block !== undefined && matchProjectId(name, block, lookup) === projectRef.value,
  )?.name;
};

/**
 * The load failure for a duplicate or malformed remote `project_id`, if any. Runs on every load,
 * regardless of which remote is selected.
 */
export const cliConfigRemoteFailure = (
  remotes: Readonly<Record<string, unknown>>,
  lookup: EnvLookup,
): string | undefined => {
  const seen = new Map<string, string>();
  for (const { name, block } of remoteBlocks(remotes)) {
    const projectId = matchProjectId(name, block, lookup);
    if (projectId === undefined) continue;
    const prior = seen.get(projectId);
    if (prior !== undefined) {
      return `duplicate project_id for [remotes.${name}] and [remotes.${prior}]`;
    }
    seen.set(projectId, name);
  }
  for (const { name, block } of remoteBlocks(remotes)) {
    const override = lookup(cliRemoteProjectIdEnvName(name));
    const literal = literalProjectId(block);
    const projectId =
      override ??
      (literal === undefined ? undefined : expandCliConfigEnvReference(literal, lookup));
    if (projectId === undefined || !PROJECT_REF_PATTERN.test(projectId)) {
      return `Invalid config for remotes.${name}.project_id. Must be like: abcdefghijklmnopqrst`;
    }
  }
  return undefined;
};
