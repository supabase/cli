// oxlint-disable-next-line effecttsgo/node-builtin-import -- Mailpit's native database path is resolved synchronously while constructing the process definition.
import { join } from "node:path";
import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  hostHttpHealthCheck,
  nativeRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface MailpitServiceOptions {
  readonly webPort: number;
  readonly smtpPort: number;
  readonly pop3Port: number;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface NativeMailpitOptions extends MailpitServiceOptions {
  readonly binPath: string;
  /** Directory owned by this stack for Mailpit's SQLite database. */
  readonly dataDir: string;
}

interface DockerMailpitOptions extends MailpitServiceOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly platformOs: string;
}

const mailpitHealthCheck = (port: number): ServiceDef["healthCheck"] =>
  hostHttpHealthCheck(port, "/readyz", {
    ...stackHealthBudgets.mailpit,
  });

const mailpitEnv = (
  opts: MailpitServiceOptions,
  host: "127.0.0.1" | "0.0.0.0",
  dataDir?: string,
): Record<string, string> => ({
  MP_UI_BIND_ADDR: `${host}:${opts.webPort}`,
  MP_SMTP_BIND_ADDR: `${host}:${opts.smtpPort}`,
  MP_POP3_BIND_ADDR: `${host}:${opts.pop3Port}`,
  MP_SMTP_DISABLE_RDNS: "true",
  ...(dataDir === undefined ? {} : { MP_DATABASE: join(dataDir, "mailpit.db") }),
});

export const makeMailpitServiceDocker = (opts: DockerMailpitOptions): ServiceDef =>
  dockerRunService({
    runtime: opts.runtime,
    name: "mailpit",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.webPort, opts.smtpPort, opts.pop3Port]),
    dependencies: opts.dependencies,
    env: mailpitEnv(opts, "0.0.0.0"),
    healthCheck: mailpitHealthCheck(opts.webPort),
  });

export const makeMailpitServiceNative = (opts: NativeMailpitOptions): ServiceDef =>
  nativeRunService({
    name: "mailpit",
    command: `${opts.binPath}/bin/mailpit`,
    env: mailpitEnv(opts, "127.0.0.1", opts.dataDir),
    dependencies: opts.dependencies,
    healthCheck: mailpitHealthCheck(opts.webPort),
  });
