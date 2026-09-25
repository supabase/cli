import { describe, expect, it } from "@effect/vitest";
import {
  NATIVE_POSTGRES_USER_ENV,
  parsePasswd,
  resolvePostgresUser,
  type PasswdEntry,
} from "./postgres-user.ts";

const entry = (name: string, uid: number, gid = uid): PasswdEntry => ({
  name,
  uid,
  gid,
  home: `/home/${name}`,
});
const root = entry("root", 0);
const postgres = entry("postgres", 102);
const nobody = entry("nobody", 65_534);
const ubuntu = entry("ubuntu", 1000);
const dev = entry("dev", 1001);
const sandbox = { CLAUDECODE: "1", IS_SANDBOX: "yes" };
const override = (name: string) => ({ [NATIVE_POSTGRES_USER_ENV]: name });

const asRoot = (env: Record<string, string>, passwd: ReadonlyArray<PasswdEntry>) =>
  resolvePostgresUser({ runtime: "native", uid: 0, env, passwd });
const userOf = (env: Record<string, string>, passwd: ReadonlyArray<PasswdEntry>) => {
  const resolution = asRoot(env, passwd);
  return resolution._tag === "StepDown" ? resolution.user.name : resolution._tag;
};

describe("parsePasswd", () => {
  it("keeps well-formed entries and skips comments and malformed lines", () => {
    const passwd = [
      "root:x:0:0:root:/root:/bin/bash",
      "# comment",
      "broken line",
      "postgres:x:102:104::/var/lib/postgresql:/usr/sbin/nologin",
    ].join("\n");
    expect(parsePasswd(passwd)).toEqual([
      { name: "root", uid: 0, gid: 0, home: "/root" },
      { name: "postgres", uid: 102, gid: 104, home: "/var/lib/postgresql" },
    ]);
  });
});

describe("resolvePostgresUser", () => {
  it("is not needed outside native or for a non-root process", () => {
    const passwd = [root, ubuntu];
    expect(resolvePostgresUser({ runtime: "docker", uid: 0, env: sandbox, passwd })._tag).toBe(
      "NotNeeded",
    );
    expect(resolvePostgresUser({ runtime: "native", uid: 501, env: sandbox, passwd })._tag).toBe(
      "NotNeeded",
    );
  });

  it("prefers the sandbox's user, then postgres, then the lowest uid at or above 1000", () => {
    expect(userOf(sandbox, [root, postgres, dev, ubuntu])).toBe("ubuntu");
    expect(userOf(sandbox, [root, dev, postgres])).toBe("postgres");
    expect(userOf(sandbox, [root, entry("svc", 998), entry("ci", 1002), dev])).toBe("dev");
  });

  it("skips root, nobody, and root-group accounts", () => {
    const unusable = [
      { ...root, name: "ubuntu" },
      { ...nobody, name: "postgres" },
    ];
    expect(userOf(sandbox, [...unusable, { ...dev, gid: 0 }])).toBe("Unavailable");
  });

  it("honours an override inside or outside a sandbox and rejects unusable ones", () => {
    expect(userOf(override("postgres"), [root, ubuntu, postgres])).toBe("postgres");
    expect(userOf({ ...sandbox, ...override("postgres") }, [ubuntu, postgres])).toBe("postgres");
    expect(asRoot(override("ghost"), [ubuntu])).toMatchObject({
      message: `${NATIVE_POSTGRES_USER_ENV}=ghost does not name a known user`,
    });
    expect(asRoot(override("root"), [root])).toMatchObject({
      message: expect.stringContaining("uid 0 and gid 0"),
    });
  });

  it("fails as root outside a sandbox and points at the override", () => {
    expect(asRoot({ CLAUDECODE: "1" }, [root, ubuntu])).toEqual({
      _tag: "Unavailable",
      message: "PostgreSQL cannot be run as root",
      suggestion: `Set ${NATIVE_POSTGRES_USER_ENV}=<user> to run PostgreSQL as a non-root user.`,
    });
  });

  it("explains which user PostgreSQL runs as and why", () => {
    expect(asRoot(sandbox, [ubuntu])).toMatchObject({
      message:
        "Running as root in Claude Code sandbox; PostgreSQL will run as preferred user 'ubuntu' (uid 1000)",
    });
  });
});
