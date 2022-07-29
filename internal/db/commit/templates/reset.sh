#!/bin/sh
set -eu

dropdb --username postgres --host 127.0.0.1 --if-exists "$DB_NAME" || true
createdb --username postgres --host 127.0.0.1 "$DB_NAME"
