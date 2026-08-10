import { managedStackContractFixtures } from "@supabase/stack/testing";
import { describe, expect, it } from "vitest";

describe("experimental managed stack command contract", () => {
  it("consumes the shared new-branch result as CLI arguments and user-visible output", () => {
    const scenario = managedStackContractFixtures.find(
      ({ id }) => id === "identity.new-branch-first-start-creates-stack",
    );

    expect(scenario?.when).toEqual({
      interface: "cli",
      argv: ["start", "--experimental"],
      cwd: "checkout-a",
    });
    expect(scenario?.expected.output).toEqual({
      human: {
        summary: "Created feat-a/default",
        fields: {
          branch: "feat-a",
          stack: "default",
          stackId: "stack-feat-a-default",
        },
      },
      json: {
        outcome: "create",
        context_id: "context-feat-a",
        stack_id: "stack-feat-a-default",
      },
    });
  });

  it("consumes structured engine failures without adding a second port decision", () => {
    const scenario = managedStackContractFixtures.find(
      ({ id }) => id === "ports.explicit-port-conflict-fails",
    );

    expect(scenario?.when).toEqual({
      interface: "cli",
      argv: ["start", "--experimental"],
      cwd: "checkout-a",
    });
    expect(scenario?.expected.output).toMatchObject({
      human: {
        summary: "Cannot start because configured port 54321 is in use",
        fields: {
          port: "54321",
          configKey: "api.port",
          owner: "external-process",
        },
      },
      json: {
        outcome: "error",
        code: "exact_port_occupied",
        port: 54321,
        config_key: "api.port",
        owner: "external-process",
      },
    });
    expect(scenario?.expected.writes).toEqual([]);
    expect(scenario?.expected.runtimeEffects).toEqual([]);
  });
});
