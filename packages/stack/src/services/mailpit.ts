import type { ServiceDef } from "@supabase/process-compose";
import { dockerRunService, hostHttpHealthCheck } from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface DockerMailpitOptions {
  readonly image: string;
  readonly apiPort: number;
  readonly healthPort: number;
  readonly networkArgs: ReadonlyArray<string>;
}

export const mailpitContainerPorts = {
  web: 8025,
  smtp: 1025,
  pop3: 1110,
} as const;

const mailpitHealthCheck = (port: number): ServiceDef["healthCheck"] =>
  hostHttpHealthCheck(port, "/readyz", {
    ...stackHealthBudgets.mailpit,
  });

export const makeMailpitServiceDocker = (opts: DockerMailpitOptions): ServiceDef =>
  dockerRunService({
    name: "mailpit",
    containerName: `supabase-mailpit-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
    env: {
      MP_UI_BIND_ADDR: `0.0.0.0:${mailpitContainerPorts.web}`,
      MP_SMTP_BIND_ADDR: `0.0.0.0:${mailpitContainerPorts.smtp}`,
      MP_POP3_BIND_ADDR: `0.0.0.0:${mailpitContainerPorts.pop3}`,
      MP_SMTP_DISABLE_RDNS: "true",
    },
    healthCheck: mailpitHealthCheck(opts.healthPort),
  });
