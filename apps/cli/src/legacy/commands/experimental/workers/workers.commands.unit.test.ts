import { describe, expect, it } from "vitest";
import {
  legacyWorkersCommand,
  legacyWorkersPushCommand,
  legacyWorkersStatusCommand,
} from "./workers.commands.ts";

/**
 * These strings are copy-pasted out of the terminal, so the exact spelling is
 * the contract. Pinned here so moving the family again is one deliberate edit
 * rather than a sweep that misses call sites — which is how the last move went.
 */
describe("legacyWorkersCommand", () => {
  it("prefixes the family path", () => {
    expect(legacyWorkersCommand("list")).toBe("supabase experimental workers list");
  });

  it("carries an explicit --project-ref into a push suggestion", () => {
    expect(legacyWorkersPushCommand("api", " --project-ref demo")).toBe(
      "supabase experimental workers push api --project-ref demo",
    );
  });

  // The suffix is empty when the ref came from the link, where repeating it is
  // noise on a command that already resolves correctly.
  it("omits the ref when there is none to carry", () => {
    expect(legacyWorkersPushCommand("api")).toBe("supabase experimental workers push api");
    expect(legacyWorkersStatusCommand("api")).toBe("supabase experimental workers status api");
  });
});
