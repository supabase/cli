/**
 * Canonical custom_nginx.template body; do not hand-edit. Unlike `kong.yml`, this is not parsed
 * as a text template — Kong's own openresty templating substitutes `${{VAR}}` at container boot, so
 * the backslash in `\${{...}}` here only escapes JS template-literal syntax.
 */
export const START_CUSTOM_NGINX_TEMPLATE = `pid pids/nginx.pid;                      # this setting is mandatory
error_log logs/error.log \${{LOG_LEVEL}}; # can be set by kong.conf

# injected nginx_main_* directives
> for _, el in ipairs(nginx_main_directives) do
$(el.name) $(el.value);
> end

events {
    # injected nginx_events_* directives
> for _, el in ipairs(nginx_events_directives) do
    $(el.name) $(el.value);
> end
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
