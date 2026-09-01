// oxlint-disable effecttsgo/node-builtin-import -- Entrypoint integration tests invoke the native process boundary directly.

import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("loads the managed entrypoint in Node without a TypeScript transform", () => {
  const entrypoint = new URL("./managed-node.ts", import.meta.url).href;
  expect(() =>
    execFileSync(
      "node",
      ["--input-type=module", "--eval", `await import(${JSON.stringify(entrypoint)})`],
      {
        stdio: "pipe",
      },
    ),
  ).not.toThrow();
});
