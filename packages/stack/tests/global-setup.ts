import { warmStackE2eDependencies } from "./helpers/warmup.ts";

export async function setup(): Promise<void> {
  await warmStackE2eDependencies();
}
