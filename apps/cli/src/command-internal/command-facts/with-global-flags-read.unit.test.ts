import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Command } from "effect/cli";

import { DebugFlag, YesFlag } from "../global-flags.ts";
import { withGlobalFlagsRead } from "./with-global-flags-read.ts";

const readsDebug = Command.make("leaf", {}).pipe(
  Command.withHandler(() => Effect.asVoid(Effect.service(DebugFlag))),
);

describe("withGlobalFlagsRead", () => {
  it("accepts a leaf that declares exactly the global flags it reads", () => {
    const leaf = readsDebug.pipe(withGlobalFlagsRead([DebugFlag]));
    expect(leaf.name).toBe("leaf");
  });

  it("rejects a leaf that reads an undeclared global flag", () => {
    // @ts-expect-error -- DebugFlag is read but not declared
    const leaf = readsDebug.pipe(withGlobalFlagsRead([]));
    expect(leaf).toHaveProperty("name", "leaf");
  });

  it("rejects a leaf that declares a global flag it never reads", () => {
    // @ts-expect-error -- YesFlag is declared but never read
    const leaf = readsDebug.pipe(withGlobalFlagsRead([DebugFlag, YesFlag]));
    expect(leaf).toHaveProperty("name", "leaf");
  });
});
