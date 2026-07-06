import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

/** Writes a Docker CLI-shaped `$DOCKER_CONFIG` directory (`config.json` + a context store entry). */
function writeDockerConfigDir(options: {
  readonly currentContext?: string;
  readonly contexts?: Readonly<Record<string, string>>; // context name -> docker.Host endpoint
}): string {
  const dir = mkdtempSync(join(tmpdir(), "legacy-hostname-docker-config-"));
  if (options.currentContext !== undefined) {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ currentContext: options.currentContext }),
    );
  }
  for (const [name, host] of Object.entries(options.contexts ?? {})) {
    const contextId = createHash("sha256").update(name).digest("hex");
    const metaDir = join(dir, "contexts", "meta", contextId);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      join(metaDir, "meta.json"),
      JSON.stringify({ Endpoints: { docker: { Host: host } } }),
    );
  }
  return dir;
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

  describe("active Docker context resolution (Go's Docker.DaemonHost() parity)", () => {
    let configDirs: Array<string> = [];

    afterEach(() => {
      for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
      configDirs = [];
    });

    function withDockerConfig<T>(
      options: Parameters<typeof writeDockerConfigDir>[0],
      env: Record<string, string | undefined>,
      run: () => T,
    ): T {
      const dir = writeDockerConfigDir(options);
      configDirs.push(dir);
      return withEnv(
        {
          SUPABASE_SERVICES_HOSTNAME: undefined,
          DOCKER_HOST: undefined,
          DOCKER_CONFIG: dir,
          ...env,
        },
        run,
      );
    }

    it("resolves the host from the active context's tcp:// endpoint via config.json's currentContext", () => {
      const result = withDockerConfig(
        { currentContext: "remote", contexts: { remote: "tcp://remote-host:2375" } },
        {},
        legacyGetHostname,
      );
      expect(result).toBe("remote-host");
    });

    it("prefers DOCKER_CONTEXT over config.json's currentContext", () => {
      const result = withDockerConfig(
        {
          currentContext: "other",
          contexts: { envctx: "tcp://envctx-host:2375", other: "tcp://other-host:2375" },
        },
        { DOCKER_CONTEXT: "envctx" },
        legacyGetHostname,
      );
      expect(result).toBe("envctx-host");
    });

    it("strips brackets from an IPv6 context endpoint (net.SplitHostPort parity)", () => {
      const result = withDockerConfig(
        { currentContext: "remote", contexts: { remote: "tcp://[::1]:2375" } },
        {},
        legacyGetHostname,
      );
      expect(result).toBe("::1");
    });

    it("falls back to 127.0.0.1 when the active context's endpoint is not tcp://", () => {
      const result = withDockerConfig(
        { currentContext: "remote", contexts: { remote: "unix:///var/run/docker.sock" } },
        {},
        legacyGetHostname,
      );
      expect(result).toBe("127.0.0.1");
    });

    it("falls back to 127.0.0.1 when the context store entry is missing", () => {
      const result = withDockerConfig({ currentContext: "ghost" }, {}, legacyGetHostname);
      expect(result).toBe("127.0.0.1");
    });

    it("falls back to 127.0.0.1 when config.json is missing entirely (default context)", () => {
      const result = withDockerConfig({}, {}, legacyGetHostname);
      expect(result).toBe("127.0.0.1");
    });

    it("never consults the context store for the default context", () => {
      const result = withDockerConfig(
        { currentContext: "default", contexts: { default: "tcp://should-never-be-read:2375" } },
        {},
        legacyGetHostname,
      );
      expect(result).toBe("127.0.0.1");
    });

    it("DOCKER_HOST still takes precedence over an active non-default context", () => {
      const result = withDockerConfig(
        { currentContext: "remote", contexts: { remote: "tcp://context-host:2375" } },
        { DOCKER_HOST: "tcp://direct-host:2375" },
        legacyGetHostname,
      );
      expect(result).toBe("direct-host");
    });
  });
});
