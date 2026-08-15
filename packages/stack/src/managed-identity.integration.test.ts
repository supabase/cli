import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const publicationGate = vi.hoisted(() => {
  let blockTemporaryWrite = false;
  let enteredPromise = Promise.resolve();
  let releasePromise = Promise.resolve();
  let resolveEntered: () => void = () => undefined;
  let resolveRelease: () => void = () => undefined;
  return {
    begin() {
      blockTemporaryWrite = true;
      enteredPromise = new Promise<void>((resolve) => {
        resolveEntered = resolve;
      });
      releasePromise = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
    },
    isBlocked: () => blockTemporaryWrite,
    waitEntered: () => enteredPromise,
    markEntered: () => resolveEntered(),
    release() {
      blockTemporaryWrite = false;
      resolveRelease();
    },
    waitRelease: () => releasePromise,
    reset() {
      blockTemporaryWrite = false;
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      const path = args[0];
      if (publicationGate.isBlocked() && typeof path === "string" && path.includes(".tmp.")) {
        publicationGate.markEntered();
        await publicationGate.waitRelease();
      }
      return fs.writeFile(...args);
    },
  };
});

import { publishOrdinaryWorkspaceIdentity } from "./managed/identity.ts";
import { ordinaryWorkspaceIdentityPath } from "./managed/paths.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  publicationGate.reset();
});

describe("ordinary identity publication", () => {
  it("does not expose interruption before a marker publication settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "managed-identity-test-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const identity = {
      projectId: "00000000-0000-7000-8000-000000000601",
      checkoutId: "00000000-0000-7000-8000-000000000602",
      contextId: "00000000-0000-7000-8000-000000000603",
    };
    publicationGate.begin();
    const fiber = Effect.runFork(
      publishOrdinaryWorkspaceIdentity(workspace, identity, "00000000-0000-7000-8000-000000000604"),
    );
    await publicationGate.waitEntered();

    let interruptionSettled = false;
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interruptionSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      expect(interruptionSettled).toBe(false);
    } finally {
      publicationGate.release();
    }
    await interruption;
    expect(readFileSync(ordinaryWorkspaceIdentityPath(workspace), "utf8")).toContain(
      identity.projectId,
    );
  });
});
