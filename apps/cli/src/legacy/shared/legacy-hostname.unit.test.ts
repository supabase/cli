import { describe, expect, it } from "vitest";

import { legacyGetHostname } from "./legacy-hostname.ts";

function withEnv<T>(entries: Record<string, string | undefined>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(entries)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("legacyGetHostname", () => {
  it("prefers SUPABASE_SERVICES_HOSTNAME over everything else", () => {
    expect(
      withEnv(
        { SUPABASE_SERVICES_HOSTNAME: "db.internal", DOCKER_HOST: "tcp://docker:2375" },
        legacyGetHostname,
      ),
    ).toBe("db.internal");
  });

  it("derives the host from a tcp:// DOCKER_HOST when no override is set", () => {
    expect(
      withEnv(
        { SUPABASE_SERVICES_HOSTNAME: undefined, DOCKER_HOST: "tcp://docker-host:2375" },
        legacyGetHostname,
      ),
    ).toBe("docker-host");
  });

  it("strips the brackets from an IPv6 tcp:// DOCKER_HOST (net.SplitHostPort parity)", () => {
    // WHATWG URL.hostname returns `[::1]`; Go's net.SplitHostPort returns the bare
    // `::1`, which is what gets dialed/compared, so the brackets must be stripped.
    expect(
      withEnv(
        { SUPABASE_SERVICES_HOSTNAME: undefined, DOCKER_HOST: "tcp://[::1]:2375" },
        legacyGetHostname,
      ),
    ).toBe("::1");
  });

  it("falls back to 127.0.0.1 for a unix-socket DOCKER_HOST", () => {
    expect(
      withEnv(
        { SUPABASE_SERVICES_HOSTNAME: undefined, DOCKER_HOST: "unix:///var/run/docker.sock" },
        legacyGetHostname,
      ),
    ).toBe("127.0.0.1");
  });

  it("falls back to 127.0.0.1 when neither env var is set", () => {
    expect(
      withEnv({ SUPABASE_SERVICES_HOSTNAME: undefined, DOCKER_HOST: undefined }, legacyGetHostname),
    ).toBe("127.0.0.1");
  });
});
