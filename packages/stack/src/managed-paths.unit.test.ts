import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertManagedUuid } from "./managed/ids.ts";
import { InvalidManagedIdentityError, UnsafeManagedStackPathError } from "./managed/model.ts";
import {
  assertManagedStackRoot,
  managedStackPaths,
  resolveManagedStateRoot,
} from "./managed/paths.ts";

describe("managed paths", () => {
  it.each([
    ["empty", ""],
    ["wrong-length", "018f8b4e-8e5c-7e32-a956-6f297fd05a2"],
    ["non-hex", "018f8b4g-8e5c-7e32-a956-6f297fd05a2d"],
    ["unsupported version", "018f8b4e-8e5c-0e32-a956-6f297fd05a2d"],
    ["invalid variant", "018f8b4e-8e5c-7e32-7956-6f297fd05a2d"],
  ])("rejects %s managed UUIDs", (_case, value) => {
    expect(() => assertManagedUuid(value, "test id")).toThrow(InvalidManagedIdentityError);
  });

  it("isolates managed records beneath SUPABASE_HOME", () => {
    expect(
      resolveManagedStateRoot({
        env: { SUPABASE_HOME: "/configured/supabase" },
        homeDir: "/home/user",
        platform: "linux",
      }),
    ).toBe("/configured/supabase/managed");
  });

  it("trims surrounding whitespace from a configured SUPABASE_HOME", () => {
    expect(
      resolveManagedStateRoot({
        env: { SUPABASE_HOME: "  /configured/supabase  " },
        homeDir: "/home/user",
        platform: "linux",
      }),
    ).toBe("/configured/supabase/managed");
  });

  it("treats whitespace-only state-root environment values as unset", () => {
    expect(
      resolveManagedStateRoot({
        env: { SUPABASE_HOME: "   " },
        homeDir: "/home/user",
        platform: "linux",
      }),
    ).toBe("/home/user/.local/state/supabase/managed");
    expect(
      resolveManagedStateRoot({
        env: { XDG_STATE_HOME: "\t" },
        homeDir: "/home/user",
        platform: "linux",
      }),
    ).toBe("/home/user/.local/state/supabase/managed");
    expect(
      resolveManagedStateRoot({
        env: { LOCALAPPDATA: " " },
        homeDir: "C:\\Users\\user",
        platform: "win32",
      }),
    ).toBe("C:\\Users\\user/AppData/Local/Supabase/managed");
  });

  it("uses platform application-state directories by default", () => {
    expect(resolveManagedStateRoot({ env: {}, homeDir: "/home/user", platform: "linux" })).toBe(
      "/home/user/.local/state/supabase/managed",
    );
    expect(resolveManagedStateRoot({ env: {}, homeDir: "/Users/user", platform: "darwin" })).toBe(
      "/Users/user/Library/Application Support/supabase/managed",
    );
    expect(
      resolveManagedStateRoot({
        env: { XDG_STATE_HOME: "" },
        homeDir: "/home/user",
        platform: "linux",
      }),
    ).toBe("/home/user/.local/state/supabase/managed");
    expect(
      resolveManagedStateRoot({
        env: { LOCALAPPDATA: "" },
        homeDir: "C:\\Users\\user",
        platform: "win32",
      }),
    ).toBe("C:\\Users\\user/AppData/Local/Supabase/managed");
  });

  it("anchors caller- and environment-supplied state roots to an absolute path", () => {
    expect(resolveManagedStateRoot({ stateRoot: "relative/managed" })).toBe(
      resolve("relative/managed"),
    );
    expect(resolveManagedStateRoot({ stateRoot: "/absolute/managed" })).toBe("/absolute/managed");
    expect(
      resolveManagedStateRoot({
        env: { SUPABASE_HOME: "relative/supabase" },
        homeDir: "/home/user",
        platform: "linux",
      }),
    ).toBe(join(resolve("relative/supabase"), "managed"));
    expect(
      resolveManagedStateRoot({
        env: { XDG_STATE_HOME: "relative/state" },
        homeDir: "/home/user",
        platform: "linux",
      }),
    ).toBe(join(resolve("relative/state"), "supabase", "managed"));
  });

  it("treats a blank explicit state root as unset", () => {
    // `resolve("")` silently yields the process' cwd, which would scatter
    // managed state across whatever directory the caller happened to run in.
    for (const stateRoot of ["", "   ", "\t"]) {
      expect(
        resolveManagedStateRoot({ stateRoot, env: {}, homeDir: "/home/user", platform: "linux" }),
      ).toBe("/home/user/.local/state/supabase/managed");
    }
    expect(
      resolveManagedStateRoot({
        stateRoot: "",
        env: { SUPABASE_HOME: "/configured/supabase" },
        homeDir: "/home/user",
        platform: "linux",
      }),
    ).toBe("/configured/supabase/managed");
  });

  it("trims surrounding whitespace from an explicit state root", () => {
    expect(resolveManagedStateRoot({ stateRoot: "  /absolute/managed  " })).toBe(
      "/absolute/managed",
    );
  });

  it("keys every mutable stack path by opaque stack ID", () => {
    expect(managedStackPaths("/state", "018f8b4e-8e5c-7e32-a956-6f297fd05a2d")).toEqual({
      root: "/state/stacks/018f8b4e-8e5c-7e32-a956-6f297fd05a2d",
      data: "/state/stacks/018f8b4e-8e5c-7e32-a956-6f297fd05a2d/data",
      logs: "/state/stacks/018f8b4e-8e5c-7e32-a956-6f297fd05a2d/logs",
      runtime: "/state/stacks/018f8b4e-8e5c-7e32-a956-6f297fd05a2d/runtime",
    });
  });

  it("rejects non-UUID IDs and registry paths that do not match the derived root", () => {
    expect(() => managedStackPaths("/state", "../../tmp/escaped")).toThrow(
      InvalidManagedIdentityError,
    );
    expect(() =>
      assertManagedStackRoot("/state", "018f8b4e-8e5c-7e32-a956-6f297fd05a2d", "/tmp/escaped"),
    ).toThrow(UnsafeManagedStackPathError);
  });
});
