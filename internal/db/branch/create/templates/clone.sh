#!/bin/bash
set -euo pipefail

createdb --username postgres --host 127.0.0.1 "$DB_NAME"
pg_dump --username postgres --host 127.0.0.1 postgres | psql --username postgres --host 127.0.0.1 "$DB_NAME"
