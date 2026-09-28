import { describe, expect, it } from "@effect/vitest";
import { identifyContainer } from "./ContainerName.ts";

const stackId = "0123456789abcdef0123";
const token = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

describe("identifyContainer", () => {
  it("names a service container after its project and service", () => {
    expect(
      identifyContainer({ stackId, project: "my-app", service: "studio" }, token, false),
    ).toEqual({
      name: "supabase-my-app-studio-a1b2c3d4e5f6",
      composeProject: "supabase-my-app-0123456789ab",
      composeService: "studio",
    });
  });

  it("marks one-shot containers with a task segment but keeps the service for grouping", () => {
    const identity = identifyContainer(
      { stackId, project: "my-app", service: "auth" },
      token,
      true,
    );
    expect(identity.name).toBe("supabase-my-app-auth-task-a1b2c3d4e5f6");
    expect(identity.composeService).toBe("auth");
  });

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
