import type { ServiceDef } from "@supabase/process-compose";
import { dockerPortMapArgs } from "../Platform.ts";
import { dockerRunService, hostHttpHealthCheck, type ServiceDependency } from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface DockerMailpitOptions {
  readonly image: string;
  readonly apiPort: number;
  readonly webPort: number;
  readonly smtpTransportPort: number;
  readonly smtpHostPort: number | false;
  readonly pop3HostPort: number | false;
  readonly platformOs: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const mailpitContainerPorts = {
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
    apiPort: opts.apiPort,
    image: opts.image,
    networkArgs: dockerPortMapArgs(opts.platformOs, [
      { host: opts.webPort, container: mailpitContainerPorts.web },
      ...(opts.smtpHostPort === false
        ? [
            {
              host: opts.smtpTransportPort,
              container: mailpitContainerPorts.smtp,
              hostAddress: "127.0.0.1",
            },
          ]
        : [{ host: opts.smtpHostPort, container: mailpitContainerPorts.smtp }]),
      ...(opts.pop3HostPort === false
        ? []
        : [{ host: opts.pop3HostPort, container: mailpitContainerPorts.pop3 }]),
    ]),
    dependencies: opts.dependencies,
    env: {
      MP_UI_BIND_ADDR: `0.0.0.0:${mailpitContainerPorts.web}`,
      MP_SMTP_BIND_ADDR: `0.0.0.0:${mailpitContainerPorts.smtp}`,
      MP_POP3_BIND_ADDR: `0.0.0.0:${mailpitContainerPorts.pop3}`,
      MP_SMTP_DISABLE_RDNS: "true",
    },
    healthCheck: mailpitHealthCheck(opts.webPort),
  });
