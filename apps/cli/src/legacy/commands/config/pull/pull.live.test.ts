import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

// Golden path only: the one thing mocks cannot prove is a real
// `GET /v2/projects/{ref}/config` response decoding, planning, and writing
// cleanly against a real (freshly-initialized) `supabase/config.toml`, and
// that a second run against the SAME project leaves nothing to write (the
// convergence check's own real-world counterpart — branch coverage lives in
// pull.integration.test.ts). The `workspace` fixture behind `cli` is a fresh
// `supabase init` project directory.
test("pulls remote config into a fresh project, leaving nothing to write on a second run", async ({
  cli,
  project,
}) => {
  const args = ["config", "pull", "--project-ref", project.ref, "--yes", "--output-format", "json"];
  const first = await cli(args);
  requireLiveSuccess(first, "config pull");
  expect(JSON.parse(first.stdout)).toEqual(expect.objectContaining({ wrote: true }));

  const second = await cli(args);
  requireLiveSuccess(second, "config pull");
  expect(JSON.parse(second.stdout)).toEqual(
    expect.objectContaining({
      wrote: false,
      scope: expect.objectContaining({ present: expect.arrayContaining(["auth"]) }),
    }),
  );
});
