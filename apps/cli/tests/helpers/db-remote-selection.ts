import { Effect } from "effect";

import { VALID_REF, jsonResponse, mockCommandPlatformApi } from "./command-mocks.ts";
import type { mockOutput } from "./mocks.ts";

export const BRANCH_PROJECT_REF = "branchprojectrefabcd";

const branchRow = (name: string) => ({
  id: "11111111-2222-4333-8444-555555555555",
  name,
  project_ref: BRANCH_PROJECT_REF,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: true,
});

/** A platform API that only answers the linked project's branch list, with one branch named `name`. */
export const branchListApi = (name = "feature-x") =>
  mockCommandPlatformApi({
    handler: (request) =>
      Effect.succeed(
        request.url.endsWith(`/v1/projects/${VALID_REF}/branches`)
          ? jsonResponse(request, 200, [branchRow(name)])
          : jsonResponse(request, 404, { message: `unexpected request ${request.url}` }),
      ),
  });

/** The text of every warning the run printed. */
export const warningsOf = (out: Pick<ReturnType<typeof mockOutput>, "messages">) =>
  out.messages.filter((message) => message.type === "warn").map((message) => message.message);
