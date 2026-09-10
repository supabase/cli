import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { makeTempHome, requireCliSuccess, runSupabase } from "../../../tests/helpers/cli.ts";

const ACCESS_TOKEN = `sbp_${"a".repeat(40)}`;
const PROFILE = {
  gotrue_id: "5a5c1690-8f6f-4b95-b76c-97b80a8868fc",
  primary_email: "person@example.com",
  username: "person",
};

test("shows the authenticated profile through the CLI", async () => {
  let request:
    | { readonly method: string; readonly pathname: string; readonly authorization: string | null }
    | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(incoming) {
      const url = new URL(incoming.url);
      if (incoming.method === "GET" && url.pathname === "/v1/profile") {
        request = {
          method: incoming.method,
          pathname: url.pathname,
          authorization: incoming.headers.get("authorization"),
        };
        return Response.json(PROFILE);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const home = makeTempHome();

  try {
    const profilePath = path.join(home.dir, "whoami-profile.yaml");
    await writeFile(
      profilePath,
      [
        "name: whoami-e2e",
        `api_url: ${JSON.stringify(server.url.origin)}`,
        `dashboard_url: ${JSON.stringify(server.url.origin)}`,
        'project_host: "example.invalid"',
        "",
      ].join("\n"),
    );

    const result = await runSupabase(["whoami", "--output-format", "json"], {
      cwd: home.dir,
      home: home.dir,
      env: {
        SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN,
        SUPABASE_PROFILE: profilePath,
        SUPABASE_WORKDIR: home.dir,
      },
    });

    requireCliSuccess(result, "whoami --output-format json");
    expect(JSON.parse(result.stdout), result.stderr).toEqual({
      id: PROFILE.gotrue_id,
      email: PROFILE.primary_email,
      username: PROFILE.username,
    });
    expect(request).toEqual({
      method: "GET",
      pathname: "/v1/profile",
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
  } finally {
    await server.stop(true);
    home[Symbol.dispose]();
  }
});
