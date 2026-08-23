// oxlint-disable effecttsgo/node-builtin-import -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { Effect } from "effect";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateManagedUuid } from "./managed/ids.ts";
import { InvalidManagedIdentityError, UnsafeManagedStackPathError } from "./managed/model.ts";
import * as managedPathsModule from "./managed/paths.ts";
import {
  assertManagedStackRootEffect,
  managedStackPathsEffect,
  resolveManagedStateRootEffect,
} from "./managed/paths.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const failureOf = <A, E>(effect: Effect.Effect<A, E>): E => Effect.runSync(Effect.flip(effect));

describe("managed paths", () => {
  it("does not expose the removed SQLite registry path", () => {
    expect(managedPathsModule).not.toHaveProperty("managedRegistryPath");
  });

  it.each([
    ["empty", ""],
    ["wrong-length", "018f8b4e-8e5c-7e32-a956-6f297fd05a2"],
    ["non-hex", "018f8b4g-8e5c-7e32-a956-6f297fd05a2d"],
    ["unsupported version", "018f8b4e-8e5c-0e32-a956-6f297fd05a2d"],
    ["invalid variant", "018f8b4e-8e5c-7e32-7956-6f297fd05a2d"],
  ])("rejects %s managed UUIDs", (_case, value) => {
    expect(failureOf(validateManagedUuid(value, "test id"))).toBeInstanceOf(
      InvalidManagedIdentityError,
    );
  });

  it("isolates managed records beneath SUPABASE_HOME", () => {
    expect(
      run(
        resolveManagedStateRootEffect({
          env: { SUPABASE_HOME: "/configured/supabase" },
          homeDir: "/home/user",
          platform: "linux",
        }),
      ),
    ).toBe("/configured/supabase/managed");
  });

  it("trims surrounding whitespace from a configured SUPABASE_HOME", () => {
    expect(
      run(
        resolveManagedStateRootEffect({
          env: { SUPABASE_HOME: "  /configured/supabase  " },
          homeDir: "/home/user",
          platform: "linux",
        }),
      ),
    ).toBe("/configured/supabase/managed");
  });

  it("treats whitespace-only state-root environment values as unset", () => {
    expect(
      run(
        resolveManagedStateRootEffect({
          env: { SUPABASE_HOME: "   " },
          homeDir: "/home/user",
          platform: "linux",
        }),
      ),
    ).toBe("/home/user/.local/state/supabase/managed");
    expect(
      run(
        resolveManagedStateRootEffect({
          env: { XDG_STATE_HOME: "\t" },
          homeDir: "/home/user",
          platform: "linux",
        }),
      ),
    ).toBe("/home/user/.local/state/supabase/managed");
    expect(
      run(
        resolveManagedStateRootEffect({
          env: { LOCALAPPDATA: " " },
          homeDir: "C:\\Users\\user",
          platform: "win32",
        }),
      ),
    ).toBe("C:\\Users\\user/AppData/Local/Supabase/managed");
  });

  it("uses platform application-state directories by default", () => {
    expect(
      run(resolveManagedStateRootEffect({ env: {}, homeDir: "/home/user", platform: "linux" })),
    ).toBe("/home/user/.local/state/supabase/managed");
    expect(
      run(resolveManagedStateRootEffect({ env: {}, homeDir: "/Users/user", platform: "darwin" })),
    ).toBe("/Users/user/Library/Application Support/supabase/managed");
    expect(
      run(
        resolveManagedStateRootEffect({
          env: { XDG_STATE_HOME: "" },
          homeDir: "/home/user",
          platform: "linux",
        }),
      ),
    ).toBe("/home/user/.local/state/supabase/managed");
    expect(
      run(
        resolveManagedStateRootEffect({
          env: { LOCALAPPDATA: "" },
          homeDir: "C:\\Users\\user",
          platform: "win32",
        }),
      ),
    ).toBe("C:\\Users\\user/AppData/Local/Supabase/managed");
  });

  it("anchors caller- and environment-supplied state roots to an absolute path", () => {
    expect(run(resolveManagedStateRootEffect({ stateRoot: "relative/managed" }))).toBe(
      resolve("relative/managed"),
    );
    expect(run(resolveManagedStateRootEffect({ stateRoot: "/absolute/managed" }))).toBe(
      "/absolute/managed",
    );
    expect(
      run(
        resolveManagedStateRootEffect({
          env: { SUPABASE_HOME: "relative/supabase" },
          homeDir: "/home/user",
          platform: "linux",
        }),
      ),
    ).toBe(join(resolve("relative/supabase"), "managed"));
    expect(
      run(
        resolveManagedStateRootEffect({
          env: { XDG_STATE_HOME: "relative/state" },
          homeDir: "/home/user",
          platform: "linux",
        }),
      ),
    ).toBe(join(resolve("relative/state"), "supabase", "managed"));
  });

  it("refuses a blank explicit state root instead of falling back", () => {
    for (const stateRoot of ["", "   ", "\t"]) {
      expect(
        failureOf(
          resolveManagedStateRootEffect({
            stateRoot,
            env: {},
            homeDir: "/home/user",
            platform: "linux",
          }),
        ),
      ).toBeInstanceOf(UnsafeManagedStackPathError);
    }
    expect(
      failureOf(
        resolveManagedStateRootEffect({
          stateRoot: "",
          env: { SUPABASE_HOME: "/configured/supabase" },
          homeDir: "/home/user",
          platform: "linux",
        }),
      ),
    ).toBeInstanceOf(UnsafeManagedStackPathError);
  });

  it("names the blank root it refused instead of an empty message tail", () => {
    expect(failureOf(resolveManagedStateRootEffect({ stateRoot: "\t" }))).toMatchObject({
      path: "\t",
      message: 'Refusing a blank managed state root: "\\t"',
    });
  });

  it("trims surrounding whitespace from an explicit state root", () => {
    expect(run(resolveManagedStateRootEffect({ stateRoot: "  /absolute/managed  " }))).toBe(
      "/absolute/managed",
    );
  });

  it("keys every mutable stack path by opaque stack ID", () => {
    expect(run(managedStackPathsEffect("/state", "018f8b4e-8e5c-7e32-a956-6f297fd05a2d"))).toEqual({
      root: "/state/stacks/018f8b4e-8e5c-7e32-a956-6f297fd05a2d",
      data: "/state/stacks/018f8b4e-8e5c-7e32-a956-6f297fd05a2d/data",
      logs: "/state/stacks/018f8b4e-8e5c-7e32-a956-6f297fd05a2d/logs",
      runtime: "/state/stacks/018f8b4e-8e5c-7e32-a956-6f297fd05a2d/runtime",
    });
  });

  it("rejects non-UUID IDs and stack paths that do not match the derived root", () => {
    expect(failureOf(managedStackPathsEffect("/state", "../../tmp/escaped"))).toBeInstanceOf(
      InvalidManagedIdentityError,
    );
    expect(
      failureOf(
        assertManagedStackRootEffect(
          "/state",
          "018f8b4e-8e5c-7e32-a956-6f297fd05a2d",
          "/tmp/escaped",
        ),
      ),
    ).toBeInstanceOf(UnsafeManagedStackPathError);
  });
});
