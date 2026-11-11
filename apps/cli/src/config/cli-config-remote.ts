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

export interface CliConfigRemoteFailure {
  readonly remote: string;
  /** `duplicate` repeats another remote's `project_id`; `invalid` is not a project ref. */
  readonly kind: "duplicate" | "invalid";
  /** The remote that first used the same `project_id`, for a `duplicate`. */
  readonly duplicateOf?: string;
  readonly message: string;
  /** The env variable that supplied the rejected `project_id`, when it overrode the file. */
  readonly envName?: string;
}

const overrideField = (name: string, lookup: EnvLookup) => {
  const envName = cliRemoteProjectIdEnvName(name);
  return lookup(envName) === undefined ? {} : { envName };
};

/** Every remote with a duplicate or malformed `project_id`, one failure per remote. */
export const cliConfigRemoteFailures = (
  remotes: Readonly<Record<string, unknown>>,
  lookup: EnvLookup,
): ReadonlyArray<CliConfigRemoteFailure> => {
  const failures = new Map<string, CliConfigRemoteFailure>();
  const seen = new Map<string, string>();
  for (const { name, block } of remoteBlocks(remotes)) {
    const projectId = matchProjectId(name, block, lookup);
    if (projectId === undefined) continue;
    const prior = seen.get(projectId);
    if (prior !== undefined) {
      failures.set(name, {
        remote: name,
        kind: "duplicate",
        duplicateOf: prior,
        message: `duplicate project_id for [remotes.${name}] and [remotes.${prior}]`,
        ...overrideField(name, lookup),
      });
      continue;
    }
    seen.set(projectId, name);
  }
  for (const { name, block } of remoteBlocks(remotes)) {
    const override = lookup(cliRemoteProjectIdEnvName(name));
    const literal = literalProjectId(block);
    const projectId =
      override ??
      (literal === undefined ? undefined : expandCliConfigEnvReference(literal, lookup));
    if ((projectId === undefined || !PROJECT_REF_PATTERN.test(projectId)) && !failures.has(name)) {
      failures.set(name, {
        remote: name,
        kind: "invalid",
        message: `Invalid config for remotes.${name}.project_id. Must be like: abcdefghijklmnopqrst`,
        ...overrideField(name, lookup),
      });
    }
  }
  return [...failures.values()];
};
