import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  hostHttpHealthCheck,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface DockerMailpitOptions extends ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly webPort: number;
  readonly smtpPort: number;
  readonly pop3Port: number;
  readonly platformOs: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const mailpitHealthCheck = (port: number): ServiceDef["healthCheck"] =>
  hostHttpHealthCheck(port, "/readyz", {
    ...stackHealthBudgets.mailpit,
  });

export const makeMailpitServiceDocker = (opts: DockerMailpitOptions): ServiceDef =>
  dockerRunService({
    runtime: opts.runtime,
    name: "mailpit",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.webPort, opts.smtpPort, opts.pop3Port]),
    dependencies: opts.dependencies,
    env: {
      MP_UI_BIND_ADDR: `0.0.0.0:${opts.webPort}`,
      MP_SMTP_BIND_ADDR: `0.0.0.0:${opts.smtpPort}`,
      MP_POP3_BIND_ADDR: `0.0.0.0:${opts.pop3Port}`,
      MP_SMTP_DISABLE_RDNS: "true",
    },
    healthCheck: mailpitHealthCheck(opts.webPort),
  });
