import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  InvalidManagedIdentityError,
  ORDINARY_WORKSPACE_IDENTITY_VERSION,
  type OrdinaryWorkspaceIdentity,
} from "./model.ts";
import { assertManagedUuid, createManagedUuid } from "./ids.ts";
import { errorCode } from "./error-code.ts";
import { ordinaryWorkspaceIdentityPath } from "./paths.ts";

const identityField = (value: unknown, field: string): string => {
  if (typeof value !== "object" || value === null) {
    throw new InvalidManagedIdentityError({
      message: "The ordinary workspace identity must be an object",
    });
  }
  const fieldValue = Reflect.get(value, field);
  if (typeof fieldValue !== "string") {
    throw new InvalidManagedIdentityError({ message: `${field} must be an opaque UUID` });
  }
  return assertManagedUuid(fieldValue, field);
};

const decodeIdentity = (content: string): OrdinaryWorkspaceIdentity => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause: unknown) {
    throw new InvalidManagedIdentityError({
      message: `The ordinary workspace identity is not JSON: ${cause}`,
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new InvalidManagedIdentityError({
      message: "The ordinary workspace identity must be an object",
    });
  }
  const version = Reflect.get(value, "version");
  if (version !== ORDINARY_WORKSPACE_IDENTITY_VERSION) {
    throw new InvalidManagedIdentityError({
      message: `Unsupported ordinary workspace identity version ${String(version)}`,
    });
  }
  return {
    version,
    projectId: identityField(value, "projectId"),
    checkoutId: identityField(value, "checkoutId"),
    contextId: identityField(value, "contextId"),
  };
};

export const canonicalizeOrdinaryWorkspacePath = async (workspacePath: string): Promise<string> => {
  const info = await stat(workspacePath);
  if (!info.isDirectory()) {
    throw new InvalidManagedIdentityError({ message: `${workspacePath} is not a directory` });
  }
  return realpath(workspacePath);
};

export const readOrdinaryWorkspaceIdentity = async (
  workspacePath: string,
): Promise<OrdinaryWorkspaceIdentity | undefined> => {
  const markerPath = ordinaryWorkspaceIdentityPath(workspacePath);
  try {
    return decodeIdentity(await readFile(markerPath, "utf8"));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

export interface EnsureOrdinaryWorkspaceIdentityResult {
  readonly identity: OrdinaryWorkspaceIdentity;
  readonly created: boolean;
  readonly markerPath: string;
}

export const ensureOrdinaryWorkspaceIdentity = async (
  workspacePath: string,
  idFactory: () => string = randomUUID,
): Promise<EnsureOrdinaryWorkspaceIdentityResult> => {
  const existing = await readOrdinaryWorkspaceIdentity(workspacePath);
  const markerPath = ordinaryWorkspaceIdentityPath(workspacePath);
  if (existing !== undefined) {
    return { identity: existing, created: false, markerPath };
  }

  const identity: OrdinaryWorkspaceIdentity = {
    version: ORDINARY_WORKSPACE_IDENTITY_VERSION,
    projectId: createManagedUuid(idFactory, "projectId"),
    checkoutId: createManagedUuid(idFactory, "checkoutId"),
    contextId: createManagedUuid(idFactory, "contextId"),
  };

  await mkdir(dirname(markerPath), { recursive: true });
  const temporaryPath = `${markerPath}.tmp.${createManagedUuid(idFactory, "identity temporary id")}`;
  await writeFile(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  try {
    await link(temporaryPath, markerPath);
    return { identity, created: true, markerPath };
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    const winner = await readOrdinaryWorkspaceIdentity(workspacePath);
    if (winner === undefined) {
      throw new InvalidManagedIdentityError({
        message: "Identity publication raced without a winning marker",
      });
    }
    return { identity: winner, created: false, markerPath };
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};
