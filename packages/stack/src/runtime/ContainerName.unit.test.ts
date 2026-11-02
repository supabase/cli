import { describe, expect, it } from "@effect/vitest";
import { identifyContainer } from "./ContainerName.ts";

const stackId = "0123456789abcdef0123";
const token = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

describe("identifyContainer", () => {
  it("keeps dotted folder names in the container name but not in the compose project", () => {
    const identity = identifyContainer(
      { stackId, project: "My.App", service: "rest" },
      token,
      false,
    );
    expect(identity.name).toBe("supabase-My.App-rest-a1b2c3d4e5f6");
    expect(identity.composeProject).toBe("supabase-my-app-0123456789ab");
  });

  it("replaces characters outside the docker name alphabet and bounds the length", () => {
    const identity = identifyContainer(
      { stackId, project: `café ${"x".repeat(60)}`, service: "database" },
      token,
      false,
    );
    expect(identity.name).toMatch(/^supabase-caf-x+-database-a1b2c3d4e5f6$/u);
    expect(identity.name.length).toBeLessThanOrEqual(
      "supabase-".length + 40 + "-database-".length + 12,
    );
    expect(identity.composeProject).toMatch(/^supabase-[a-z0-9_-]{1,40}-0123456789ab$/u);
  });

  it("falls back to generic segments when the project and service are unknown", () => {
    expect(identifyContainer({ stackId }, token, true)).toEqual({
      name: "supabase-task-a1b2c3d4e5f6",
      composeProject: "supabase-stack-0123456789ab",
      composeService: "task",
    });
  });
});
