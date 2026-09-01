// oxlint-disable effecttsgo/async-function -- Vitest global setup awaits the native stack dependency warmup boundary.

import { warmStackE2eDependencies } from "./helpers/warmup.ts";

export async function setup(): Promise<void> {
  await warmStackE2eDependencies({ failOnError: true });
}
