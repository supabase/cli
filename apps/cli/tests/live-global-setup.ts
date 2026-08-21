import type { ProvidedContext } from "vitest";

import "./helpers/live-provided-context.ts";
import { cleanupLiveEnvironment, provisionLiveEnvironment } from "./helpers/live-project.ts";
import { validateLiveConfig } from "./helpers/live-env.ts";

type LiveSetupContext = {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
};

/** Provision one disposable project for the entire serial live Vitest run. */
export async function setup({ provide }: LiveSetupContext): Promise<() => Promise<void>> {
  validateLiveConfig();
  const environment = await provisionLiveEnvironment();
  provide("liveProject", environment.project);
  provide("liveProfilePath", environment.profilePath);
  return async () => cleanupLiveEnvironment(environment);
}

export default setup;
