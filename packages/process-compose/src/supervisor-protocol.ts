const supervisorEnv = {
  selfDispatch: "PROCESS_COMPOSE_SUPERVISOR_SELF_DISPATCH",
  runSupervisor: "PROCESS_COMPOSE_RUN_SUPERVISOR",
  config: "PROCESS_COMPOSE_SUPERVISOR_CONFIG",
};

type SupervisorEnv = Record<string, string | undefined>;

function isBunVirtualFileSystemUrl(importMetaUrl: string): boolean {
  return importMetaUrl.startsWith("file:///$bunfs/");
}

export function enableSupervisorSelfDispatchForCompiledBun(
  importMetaUrl: string,
  env: SupervisorEnv = process.env,
): void {
  if (isBunVirtualFileSystemUrl(importMetaUrl)) {
    env[supervisorEnv.selfDispatch] = "1";
  }
}

export function isSupervisorSelfDispatchEnabled(
  importMetaUrl: string,
  env: SupervisorEnv = process.env,
): boolean {
  return isBunVirtualFileSystemUrl(importMetaUrl) && env[supervisorEnv.selfDispatch] === "1";
}

export function makeSupervisorRuntimeEnv(
  encodedConfig: string,
  env: SupervisorEnv = {},
): SupervisorEnv {
  return {
    ...env,
    [supervisorEnv.runSupervisor]: "1",
    [supervisorEnv.config]: encodedConfig,
  };
}

export function isSupervisorRuntimeRequested(env: SupervisorEnv = process.env): boolean {
  return env[supervisorEnv.runSupervisor] === "1";
}

export function supervisorRuntimeConfigFromEnv(
  env: SupervisorEnv = process.env,
): string | undefined {
  return env[supervisorEnv.config];
}

export function withoutSupervisorRuntimeEnv(env: SupervisorEnv = process.env): SupervisorEnv {
  const next = { ...env };
  delete next[supervisorEnv.selfDispatch];
  delete next[supervisorEnv.runSupervisor];
  delete next[supervisorEnv.config];
  return next;
}
