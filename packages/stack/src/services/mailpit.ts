import type { ServiceDef } from "@supabase/process-compose";
import { dockerRunService, hostHttpHealthCheck } from "./service-utils.ts";

interface DockerMailpitOptions {
  readonly image: string;
  readonly apiPort: number;
  readonly webPort: number;
  readonly smtpPort: number;
  readonly pop3Port: number;
  readonly networkArgs: ReadonlyArray<string>;
}

const mailpitHealthCheck = (port: number): ServiceDef["healthCheck"] =>
  hostHttpHealthCheck(port, "/readyz", {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    failureThreshold: 30,
  });

export const makeMailpitServiceDocker = (opts: DockerMailpitOptions): ServiceDef =>
  dockerRunService({
    name: "mailpit",
    containerName: `supabase-mailpit-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
    env: {
      MP_UI_BIND_ADDR: `0.0.0.0:${opts.webPort}`,
      MP_SMTP_BIND_ADDR: `0.0.0.0:${opts.smtpPort}`,
      MP_POP3_BIND_ADDR: `0.0.0.0:${opts.pop3Port}`,
      MP_SMTP_DISABLE_RDNS: "true",
    },
    healthCheck: mailpitHealthCheck(opts.webPort),
  });
