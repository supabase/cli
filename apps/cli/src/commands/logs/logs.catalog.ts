export const COMPUTE_LOG_STREAMS = {
  app: "worker_guest_logs",
  requests: "worker_ingress_logs",
  builds: "worker_api_logs",
} as const;

export const hostedSources = [
  { service: "edge", source: "edge_logs" },
  { service: "postgres", source: "postgres_logs" },
  { service: "postgrest", source: "postgrest_logs" },
  { service: "auth", source: "auth_logs" },
  { service: "auth-audit", source: "auth_audit_logs" },
  { service: "storage", source: "storage_logs" },
  { service: "realtime", source: "realtime_logs" },
  { service: "functions", source: "function_logs" },
  { service: "function-edge", source: "function_edge_logs" },
  { service: "supavisor", source: "supavisor_logs" },
  { service: "pgbouncer", source: "pgbouncer_logs" },
  { service: "pg-upgrade", source: "pg_upgrade_logs" },
  { service: "compute", source: "", kinds: ["app", "requests", "builds"] },
] as const;

export const quoteLogValue = (value: string) =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

export const hostedSeveritySql = `multiIf(
  source = 'postgres_logs', multiIf(upper(log_attributes['parsed.error_severity']) in ('ERROR','FATAL','PANIC'), 'error', upper(log_attributes['parsed.error_severity']) = 'WARNING', 'warn', lower(log_attributes['parsed.error_severity'])),
  source in ('edge_logs','function_edge_logs'), multiIf(toInt32OrZero(log_attributes['response.status_code']) >= 500, 'error', toInt32OrZero(log_attributes['response.status_code']) >= 400, 'warn', toInt32OrZero(log_attributes['response.status_code']) >= 100, 'info', ''),
  source = 'auth_logs', multiIf(lower(log_attributes['level']) in ('error','fatal') or toInt32OrZero(log_attributes['status']) >= 500, 'error', lower(log_attributes['level']) in ('warn','warning') or toInt32OrZero(log_attributes['status']) >= 400, 'warn', lower(log_attributes['level'])),
  source = 'function_logs', multiIf(lower(log_attributes['level']) in ('error','fatal'), 'error', lower(log_attributes['level']) in ('warn','warning'), 'warn', lower(log_attributes['level'])),
  log_attributes['subservice'] = 'worker_ingress_logs', multiIf(toInt32OrZero(log_attributes['status']) >= 500, 'error', toInt32OrZero(log_attributes['status']) >= 400, 'warn', toInt32OrZero(log_attributes['status']) >= 100, 'info', ''),
  log_attributes['subservice'] = 'worker_api_logs', if(log_attributes['event'] = 'build_failed', 'error', 'info'),
  '')`;
export const severityServices: ReadonlyArray<string> = [
  "postgres",
  "edge",
  "auth",
  "functions",
  "function-edge",
  "compute",
];
