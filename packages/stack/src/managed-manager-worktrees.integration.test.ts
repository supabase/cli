// oxlint-disable effecttsgo/multiple-effect-provide, effecttsgo/node-builtin-import -- Worktree-manager tests use native path fixtures to model isolated workspaces; manager dependencies are intentionally provided in dependency order.
import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { ManagedStackManager } from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { git, makeRepository } from "../tests/helpers/git-workspace.ts";
import {
  automaticDocument,
  cleanupRoots,
  releaseLease,
  setupManagedManager,
  startWithOwner,
} from "../tests/helpers/managed-manager.ts";

const roots: Array<string> = [];
afterEach(() => cleanupRoots(roots));
const setup = () => setupManagedManager(roots);

describe("managed stack worktrees journeys", () => {
  it.live("starts sibling worktrees concurrently with independent automatic ports", () => {
    const { layer } = setup();
    const siblingRoot = mkdtempSync(join(tmpdir(), "managed-sibling-test-"));
    roots.push(siblingRoot);
    const repository = makeRepository(siblingRoot);
    const firstWorkspace = join(siblingRoot, "first");
    const secondWorkspace = join(siblingRoot, "second");
    git(repository, "worktree", "add", "-q", firstWorkspace, "-b", "first", "main");
    git(repository, "worktree", "add", "-q", secondWorkspace, "-b", "second", "main");
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const [first, second] = yield* Effect.all(
          [
            startWithOwner(manager, firstWorkspace, automaticDocument()),
            startWithOwner(manager, secondWorkspace, automaticDocument()),
          ],
          { concurrency: "unbounded" },
        );
        expect(first.stack.id).not.toBe(second.stack.id);
        const firstPorts = new Set(first.stack.ports.map((assignment) => assignment.port));
        expect(second.stack.ports.some((assignment) => firstPorts.has(assignment.port))).toBe(
          false,
        );
        const listings = yield* manager.listStacks();
        expect(listings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: first.stack.id, status: "healthy" }),
            expect.objectContaining({ id: second.stack.id, status: "healthy" }),
          ]),
        );
        yield* releaseLease(first);
        yield* releaseLease(second);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });
});
