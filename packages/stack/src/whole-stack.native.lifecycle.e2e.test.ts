import { it } from "@effect/vitest";
import { allEager, defaultLifecycle, writeConfinement } from "../tests/whole-stack/scenarios.ts";
import { run } from "../tests/whole-stack/fixture.ts";

it.live(
  "native: default database eager lifecycle and reopen",
  () => run(defaultLifecycle("native")),
  {
    timeout: 15 * 60_000,
  },
);
it.live("native: all services eager", () => run(allEager("native")), { timeout: 15 * 60_000 });
it.live(
  "native: writes stay confined to the state root and artifact cache",
  () => run(writeConfinement("native")),
  { timeout: 15 * 60_000 },
);
