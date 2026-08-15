import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { temporaryRoots } from "../tests/helpers/git-workspace.ts";
import { createManagedStackService, makeManagedStackService } from "./managed-bun.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";

const { makeRoot, removeAll } = temporaryRoots("managed-prune-test-");
const openHandles: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const handle of openHandles.splice(0)) await handle.close();
  removeAll();
});

describe("managed identity metadata pruning", () => {
  it.each(["in-memory", "sqlite"] as const)(
    "reports unknown requested IDs through the %s repository and Promise facade",
    async (adapter) => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeManagedStackService({
              repository: createInMemoryManagedStackRepository(),
              stateRoot: join(root, "managed"),
            })
          : await createManagedStackService({ stateRoot: join(root, "managed") });
      openHandles.push(service);

      expect(
        await Effect.runPromise(
          service.repository.pruneIdentityMetadata({ locationIds: ["unknown-repository"] }),
        ),
      ).toEqual({
        removed: 0,
        prunedRecordIds: [],
        preservedRecordIds: [],
        unknownRecordIds: ["unknown-repository"],
      });
      const unknownFacadeResult = {
        removed: 0,
        prunedRecordIds: [],
        preservedRecordIds: [],
        unknownRecordIds: ["unknown-facade"],
      };
      await expect(service.prune({ recordIds: ["unknown-facade"] })).resolves.toEqual(
        unknownFacadeResult,
      );
      await expect(service.prune({ recordIds: ["unknown-facade"] })).resolves.toEqual(
        unknownFacadeResult,
      );
    },
  );
});
