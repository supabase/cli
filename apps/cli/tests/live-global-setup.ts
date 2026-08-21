import type { ProvidedContext } from "vitest";

import "./helpers/live-provided-context.ts";
import {
  assertAttachedLiveReachable,
  attachedLiveValues,
  deleteManagedLiveProject,
  provisionManagedLiveProject,
} from "./helpers/live-project.ts";
import { isLiveConfigured, liveMode, liveProfile, liveProjectRef } from "./helpers/live-env.ts";

type LiveSetupContext = {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
};

function provideEnvironment(
  provide: LiveSetupContext["provide"],
  values: {
    projectRef: string;
    anonKey: string;
    functionsUrl: string;
    dbUrl: string;
    dbPassword: string;
    storageBucket: string;
  },
  mode: "attached" | "managed",
): void {
  provide("liveMode", mode);
  provide("projectRef", values.projectRef);
  provide("anonKey", values.anonKey);
  provide("functionsUrl", values.functionsUrl);
  provide("dbUrl", values.dbUrl);
  provide("dbPassword", values.dbPassword);
  provide("storageBucket", values.storageBucket);
}

/**
 * Own one live environment for the entire Vitest run.
 *
 * Attached mode is the historical Supabox/local contract: it only probes the
 * configured platform and never mutates or deletes a project. Managed mode is
 * an explicit staging opt-in (`SUPABASE_LIVE_MODE=managed`) and creates one
 * uniquely named project, provides its wiring to workers, then deletes exactly
 * that project during global teardown unless `SUPABASE_LIVE_KEEP_PROJECT=1`.
 */
export async function setup({ provide }: LiveSetupContext): Promise<() => Promise<void>> {
  const mode = liveMode();

  if (mode === "managed") {
    if (!isLiveConfigured()) {
      throw new Error(
        "SUPABASE_LIVE_MODE=managed requires SUPABASE_ACCESS_TOKEN; refusing to provision with an ambient empty token.",
      );
    }

    // Make the managed profile/ref visible to existing collection-time gates in
    // addition to providing the values to fixtures through Vitest's context.
    if (process.env["SUPABASE_PROFILE"] === undefined) {
      process.env["SUPABASE_PROFILE"] = liveProfile();
    }
    const environment = await provisionManagedLiveProject();
    process.env["SUPABASE_LIVE_PROJECT_REF"] = environment.projectRef;
    provideEnvironment(provide, environment, mode);

    return async () => {
      await deleteManagedLiveProject(environment.projectRef);
    };
  }

  if (!isLiveConfigured()) {
    return async () => {};
  }

  await assertAttachedLiveReachable();
  const values = attachedLiveValues(liveProjectRef());
  provideEnvironment(provide, values, mode);
  return async () => {};
}

export default setup;
