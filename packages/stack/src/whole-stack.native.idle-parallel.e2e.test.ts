import { it } from "@effect/vitest";
import { parallel } from "../tests/whole-stack/scenarios.ts";
import { functionsIdleWake, idleWake, restartIdleWake } from "../tests/whole-stack/idle.ts";
import { run } from "../tests/whole-stack/fixture.ts";

it.live("native: idle and wake", () => run(idleWake("native")), { timeout: 10 * 60_000 });
it.live("native: restart preserves wake and idles again", () => run(restartIdleWake("native")), {
  timeout: 10 * 60_000,
});
it.live("native: functions idles and wakes", () => run(functionsIdleWake("native")), {
  timeout: 10 * 60_000,
});
it.live("native: parallel stack isolation", () => run(parallel("native")), {
  timeout: 30 * 60_000,
});
