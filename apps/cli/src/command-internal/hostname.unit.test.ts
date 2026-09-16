import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureLoopbackProxyBypass,
  getHostname,
  platformDefaultDockerHost,
  resolveDockerDaemonEndpoint,
} from "./hostname.ts";

const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,[::1]";

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
  const dir = mkdtempSync(join(tmpdir(), "hostname-docker-config-"));
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

describe("getHostname", () => {
  it("prefers SUPABASE_SERVICES_HOSTNAME over everything else", () => {
    expect(
      withEnv(
        { SUPABASE_SERVICES_HOSTNAME: "db.internal", DOCKER_HOST: "tcp://docker:2375" },
        getHostname,
      ),
    ).toBe("db.internal");
  });

  it("derives the host from a tcp:// DOCKER_HOST when no override is set", () => {
    expect(
      withEnv(
        { SUPABASE_SERVICES_HOSTNAME: undefined, DOCKER_HOST: "tcp://docker-host:2375" },
        getHostname,
      ),
    ).toBe("docker-host");
  });

  it("strips the brackets from an IPv6 tcp:// DOCKER_HOST (net.SplitHostPort parity)", () => {
    // WHATWG URL.hostname returns `[::1]`; Go's net.SplitHostPort returns the bare
    // `::1`, which is what gets dialed/compared, so the brackets must be stripped.
    expect(
      withEnv(
        { SUPABASE_SERVICES_HOSTNAME: undefined, DOCKER_HOST: "tcp://[::1]:2375" },
        getHostname,
      ),
    ).toBe("::1");
  });

  it("falls back to 127.0.0.1 for a unix-socket DOCKER_HOST", () => {
    expect(
      withEnv(
        { SUPABASE_SERVICES_HOSTNAME: undefined, DOCKER_HOST: "unix:///var/run/docker.sock" },
        getHostname,
      ),
    ).toBe("127.0.0.1");
  });

  it("falls back to 127.0.0.1 when neither env var is set", () => {
    expect(
      withEnv({ SUPABASE_SERVICES_HOSTNAME: undefined, DOCKER_HOST: undefined }, getHostname),
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
        getHostname,
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
        getHostname,
      );
      expect(result).toBe("envctx-host");
    });

    it("strips brackets from an IPv6 context endpoint (net.SplitHostPort parity)", () => {
      const result = withDockerConfig(
        { currentContext: "remote", contexts: { remote: "tcp://[::1]:2375" } },
        {},
        getHostname,
      );
      expect(result).toBe("::1");
    });

    it("falls back to 127.0.0.1 when the active context's endpoint is not tcp://", () => {
      const result = withDockerConfig(
        { currentContext: "remote", contexts: { remote: "unix:///var/run/docker.sock" } },
        {},
        getHostname,
      );
      expect(result).toBe("127.0.0.1");
    });

    it("falls back to 127.0.0.1 when the context store entry is missing", () => {
      const result = withDockerConfig({ currentContext: "ghost" }, {}, getHostname);
      expect(result).toBe("127.0.0.1");
    });

    it("falls back to 127.0.0.1 when config.json is missing entirely (default context)", () => {
      const result = withDockerConfig({}, {}, getHostname);
      expect(result).toBe("127.0.0.1");
    });

    it("never consults the context store for the default context", () => {
      const result = withDockerConfig(
        { currentContext: "default", contexts: { default: "tcp://should-never-be-read:2375" } },
        {},
        getHostname,
      );
      expect(result).toBe("127.0.0.1");
    });

    it("DOCKER_HOST still takes precedence over an active non-default context", () => {
      const result = withDockerConfig(
        { currentContext: "remote", contexts: { remote: "tcp://context-host:2375" } },
        { DOCKER_HOST: "tcp://direct-host:2375" },
        getHostname,
      );
      expect(result).toBe("direct-host");
    });
  });
});

describe("platformDefaultDockerHost", () => {
  it("resolves the unix default off Windows", () => {
    expect(platformDefaultDockerHost("darwin")).toBe("unix:///var/run/docker.sock");
    expect(platformDefaultDockerHost("linux")).toBe("unix:///var/run/docker.sock");
  });

  it("resolves the named-pipe default on Windows", () => {
    expect(platformDefaultDockerHost("win32")).toBe("npipe:////./pipe/docker_engine");
  });
});

describe("resolveDockerDaemonEndpoint", () => {
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
      { DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined, DOCKER_CONFIG: dir, ...env },
      run,
    );
  }

  it("returns DOCKER_HOST verbatim, non-tcp schemes included", () => {
    expect(
      withEnv({ DOCKER_HOST: "unix:///custom/engine.sock" }, resolveDockerDaemonEndpoint),
    ).toBe("unix:///custom/engine.sock");
    expect(withEnv({ DOCKER_HOST: "tcp://docker-host:2375" }, resolveDockerDaemonEndpoint)).toBe(
      "tcp://docker-host:2375",
    );
  });

  it("maps the default context to the platform-default daemon endpoint", () => {
    expect(withDockerConfig({}, {}, resolveDockerDaemonEndpoint)).toBe(platformDefaultDockerHost());
    expect(
      withDockerConfig(
        { currentContext: "default", contexts: { default: "tcp://never-read:2375" } },
        {},
        resolveDockerDaemonEndpoint,
      ),
    ).toBe(platformDefaultDockerHost());
  });

  it("returns the active context's stored endpoint verbatim", () => {
    expect(
      withDockerConfig(
        { currentContext: "remote", contexts: { remote: "tcp://remote-host:2375" } },
        {},
        resolveDockerDaemonEndpoint,
      ),
    ).toBe("tcp://remote-host:2375");
  });

  it("returns undefined for an unreadable non-default context, never the platform default", () => {
    expect(
      withDockerConfig({ currentContext: "ghost" }, {}, resolveDockerDaemonEndpoint),
    ).toBeUndefined();
  });
});

describe("configureLoopbackProxyBypass", () => {
  it.each([
    ["sets NO_PROXY when neither spelling is configured", {}, { NO_PROXY: LOOPBACK_NO_PROXY }],
    [
      "preserves an existing NO_PROXY value",
      { NO_PROXY: "example.com" },
      { NO_PROXY: `example.com,${LOOPBACK_NO_PROXY}` },
    ],
    [
      "updates the non-empty lowercase value preferred by Bun",
      { NO_PROXY: "uppercase.example", no_proxy: "lowercase.example" },
      {
        NO_PROXY: "uppercase.example",
        no_proxy: `lowercase.example,${LOOPBACK_NO_PROXY}`,
      },
    ],
    [
      "falls back to NO_PROXY when lowercase no_proxy is empty",
      { NO_PROXY: "example.com", no_proxy: "" },
      { NO_PROXY: `example.com,${LOOPBACK_NO_PROXY}`, no_proxy: "" },
    ],
  ])("%s", (_name, env, expected) => {
    configureLoopbackProxyBypass(env);

    expect(env).toEqual(expected);
  });
});
