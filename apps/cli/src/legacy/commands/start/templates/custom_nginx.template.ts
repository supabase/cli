/**
 * Transcribed verbatim from
 * `apps/cli-go/internal/start/templates/custom_nginx.template` (Go
 * `//go:embed templates/custom_nginx.template`,
 * `apps/cli-go/internal/start/start.go:111-115`). Unlike `kong.yml`, this file
 * is NOT parsed as a Go `text/template` — it's passed through unmodified into
 * the Kong container, where Kong's own openresty templating substitutes the
 * `${{VAR}}` placeholders (`LOG_LEVEL`, `NGINX_DAEMON`,
 * `NGINX_WORKER_PROCESSES`) from its own container env at boot. Do not
 * hand-edit the body — re-transcribe from the Go source if it changes.
 *
 * The `\${{...}}` sequences below are literal Kong template syntax, not a JS
 * template-literal interpolation — the backslash escapes are required so this
 * TS template literal doesn't try to evaluate `{{VAR}}` as an object literal.
 */
export const LEGACY_START_CUSTOM_NGINX_TEMPLATE = `pid pids/nginx.pid;                      # this setting is mandatory
error_log logs/error.log \${{LOG_LEVEL}}; # can be set by kong.conf

daemon \${{NGINX_DAEMON}};                     # can be set by kong.conf
worker_processes \${{NGINX_WORKER_PROCESSES}}; # can be set by kong.conf

events {
    multi_accept on;
}

http {
    # here, we declare our custom location serving our website
    # (or API portal) which we can optimize for serving static assets
    server {
        server_name email_templates;
        listen 0.0.0.0:8088 reuseport backlog=16384;

        access_log logs/email_templates_access.log;
        error_log  logs/error.log notice;

        location /email {
            autoindex on;
            root /home/kong/templates;
        }
    }

    # include default Kong Nginx config
    include 'nginx-kong.conf';
}
`;
