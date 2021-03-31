FROM kong:2.1

COPY kong.yml /var/lib/kong/kong.yml

# Run time values
ENV KONG_DATABASE=off
ENV KONG_PLUGINS=request-transformer,cors,key-auth
ENV KONG_DECLARATIVE_CONFIG=/var/lib/kong/kong.yml

EXPOSE 8000
