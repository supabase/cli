import { describe, expect, it } from "vitest";
import type { ReadyOptions, StackHandle } from "./createStack.ts";
import { resolveDaemonConfig } from "./createStack.ts";
import type { AuthConfig, PostgresConfig, PostgrestConfig, StackConfig } from "./StackBuilder.ts";

describe("createStack types", () => {
  it("StackHandle interface has expected shape", () => {
    const check = (_stack: StackHandle) => {
      const _url: string = _stack.url;
      const _publishableKey: string = _stack.publishableKey;
      const _secretKey: string = _stack.secretKey;
      const _dbUrl: string = _stack.dbUrl;
      const _start: () => Promise<void> = _stack.start;
      const _stop: () => Promise<void> = _stack.stop;
      const _dispose: () => Promise<void> = _stack.dispose;
      const _startService: (name: string) => Promise<void> = _stack.startService;
      const _stopService: (name: string) => Promise<void> = _stack.stopService;
      const _restartService: (name: string) => Promise<void> = _stack.restartService;
      const _ready: (opts?: ReadyOptions) => Promise<void> = _stack.ready;
      const _serviceReady: (name: string, opts?: ReadyOptions) => Promise<void> =
        _stack.serviceReady;
    };
    expect(check).toBeDefined();
  });

  it("StackConfig interface has expected shape", () => {
    const check = (_config: StackConfig) => {
      const _jwtSecret: string | undefined = _config.jwtSecret;
      const _postgres: PostgresConfig | undefined = _config.postgres;
      const _postgrest: PostgrestConfig | false | undefined = _config.postgrest;
      const _auth: AuthConfig | false | undefined = _config.auth;
      const _port: number | undefined = _config.port;
      const _publishableKey: string | undefined = _config.publishableKey;
      const _secretKey: string | undefined = _config.secretKey;
      void _jwtSecret;
      void _postgres;
      void _postgrest;
      void _auth;
      void _port;
      void _publishableKey;
      void _secretKey;
    };
    expect(check).toBeDefined();
  });

  it("resolveDaemonConfig derives project name and projectDir from cwd", async () => {
    const config = await resolveDaemonConfig({
      home: "/tmp/supa-home",
      cwd: "/Users/test/Code/myapp",
      postgres: {
        dataDir: "/tmp/supa-data",
      },
    });

    expect(config.name).toBe("myapp");
    expect(config.projectDir).toBe("/Users/test/Code/myapp");
    expect(config.home).toBe("/tmp/supa-home");
  });
});
