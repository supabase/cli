FROM supabase/postgres:0.13.0

COPY 00-initial-schema.sql /docker-entrypoint-initdb.d/00-initial-schema.sql
COPY auth-schema.sql /docker-entrypoint-initdb.d/auth-schema.sql
COPY storage-schema.sql /docker-entrypoint-initdb.d/storage-schema.sql

# Run time values
ENV POSTGRES_DB=postgres
ENV POSTGRES_USER=postgres
ENV POSTGRES_PASSWORD=postgres
ENV POSTGRES_PORT=5432

EXPOSE 5432
