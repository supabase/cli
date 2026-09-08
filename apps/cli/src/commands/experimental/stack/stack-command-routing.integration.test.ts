import { describe, expect, it } from "@effect/vitest";
import { legacyRespondToComplete } from "../../../cli/legacy-complete.ts";
import { legacyRootForBackend } from "../../../cli/root.ts";

const canonicalStackCommands = [
  "start",
  "stop",
  "destroy",
  "status",
  "list",
  "logs",
  "prepare",
  "restart",
] as const;

const complete = (backend: "legacy" | "stack", args: ReadonlyArray<string>) => {
  const response = legacyRespondToComplete(legacyRootForBackend(backend), ["__complete", ...args]);
  if (response === undefined) throw new Error(`No completion response for ${args.join(" ")}`);
  return response.candidates.map((candidate) => candidate.name);
};

describe("experimental stack command routing", () => {
  it("exposes the same eight canonical stack paths from both backend roots", () => {
    for (const backend of ["legacy", "stack"] as const) {
      expect(complete(backend, ["stack", ""])).toEqual(
        expect.arrayContaining([...canonicalStackCommands]),
      );
      expect(complete(backend, ["stack", ""])).toHaveLength(canonicalStackCommands.length);
    }
  });

  it("keeps stack out of the unlisted experimental namespace", () => {
    for (const backend of ["legacy", "stack"] as const) {
      expect(complete(backend, ["experimental", ""])).not.toContain("stack");
    }
  });

  it("routes top-level lifecycle aliases to the matching flag sets", () => {
    for (const flag of ["--stack", "--stack-id"] as const) {
      expect(complete("stack", ["start", "--"])).toContain(flag);
      expect(complete("stack", ["stop", "--"])).toContain(flag);
      expect(complete("stack", ["status", "--"])).toContain(flag);
    }

    expect(complete("stack", ["start", "--"])).toEqual(
      expect.arrayContaining(["--runtime", "--preparation", "--eager"]),
    );
    expect(complete("legacy", ["start", "--"])).toEqual(
      expect.arrayContaining(["--exclude", "--ignore-health-check"]),
    );
    expect(complete("legacy", ["status", "--"])).toEqual(
      expect.arrayContaining(["--override-name"]),
    );
    expect(complete("stack", ["status", "--"])).toEqual(
      expect.arrayContaining(["--env", "--override-name"]),
    );
    expect(complete("stack", ["stop", "--"])).toContain("--all");
    expect(complete("stack", ["start", "--"])).toContain("--exclude");
    expect(complete("stack", ["stop", "--"])).not.toContain("--no-backup");
  });
});
