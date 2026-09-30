import { it } from "@effect/vitest";
import { parallel } from "../tests/whole-stack/scenarios.ts";
import { idleWake } from "../tests/whole-stack/idle.ts";
import { run } from "../tests/whole-stack/fixture.ts";

it.live("Docker: idle and wake", () => run(idleWake("docker")), { timeout: 10 * 60_000 });
it.live("Docker: parallel stack isolation", () => run(parallel("docker")), {
  timeout: 30 * 60_000,
});
