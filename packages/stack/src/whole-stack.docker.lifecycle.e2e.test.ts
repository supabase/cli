import { it } from "@effect/vitest";
import { allEager, defaultLifecycle } from "../tests/whole-stack/scenarios.ts";
import { run } from "../tests/whole-stack/fixture.ts";

it.live(
  "Docker: default database eager lifecycle and reopen",
  () => run(defaultLifecycle("docker")),
  {
    timeout: 15 * 60_000,
  },
);
it.live("Docker: all services eager", () => run(allEager("docker")), { timeout: 15 * 60_000 });
