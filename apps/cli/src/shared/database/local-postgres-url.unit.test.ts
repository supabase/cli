import { describe, expect, it } from "vitest";
import { localPostgresConnectionString, publishedPostgresHostPort } from "./local-postgres-url.ts";

describe("publishedPostgresHostPort", () => {
  it("reads the first 5432/tcp HostPort", () => {
    expect(
      publishedPostgresHostPort({
        "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55432" }],
      }),
    ).toBe(55432);
  });

  it("returns undefined when Postgres is not published", () => {
    expect(publishedPostgresHostPort({ "5432/tcp": null })).toBeUndefined();
    expect(publishedPostgresHostPort({})).toBeUndefined();
    expect(publishedPostgresHostPort(null)).toBeUndefined();
  });
});

describe("localPostgresConnectionString", () => {
  it("percent-encodes the password", () => {
    expect(localPostgresConnectionString(55432, "p@ss")).toBe(
      "postgresql://postgres:p%40ss@127.0.0.1:55432/postgres",
    );
  });

  it("uses the caller-supplied host and brackets IPv6", () => {
    expect(localPostgresConnectionString(55432, "postgres", "docker.internal")).toBe(
      "postgresql://postgres:postgres@docker.internal:55432/postgres",
    );
    expect(localPostgresConnectionString(55432, "postgres", "::1")).toBe(
      "postgresql://postgres:postgres@[::1]:55432/postgres",
    );
  });
});
