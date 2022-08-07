#!/bin/sh
set -eu

# recreate shadow database from scratch
dropdb --username postgres --host 127.0.0.1 --if-exists "$DB_NAME"
createdb --username postgres --host 127.0.0.1 "$DB_NAME"

# initialise large schema here to avoid lockup
psql --username postgres --host 127.0.0.1 -d "$DB_NAME" -c "$SCHEMA"
