package repair

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
)

const (
	Applied  = "applied"
	Reverted = "reverted"
)

const (
	CREATE_VERSION_SCHEMA    = "CREATE SCHEMA IF NOT EXISTS supabase_migrations"
	CREATE_VERSION_TABLE     = "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)"
	INSERT_MIGRATION_VERSION = "INSERT INTO supabase_migrations.schema_migrations(version) VALUES($1)"
	DELETE_MIGRATION_VERSION = "DELETE FROM supabase_migrations.schema_migrations WHERE version = $1"
	CREATE_MIGRATION_TABLE   = CREATE_VERSION_SCHEMA + ";" + CREATE_VERSION_TABLE
)

func Run(ctx context.Context, config pgconn.Config, version, status string, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// Create history table if not exists
	batch := pgconn.Batch{}
	batch.ExecParams(CREATE_VERSION_SCHEMA, nil, nil, nil, nil)
	batch.ExecParams(CREATE_VERSION_TABLE, nil, nil, nil, nil)
	// Update migration history
	switch status {
	case Applied:
		InsertVersionSQL(&batch, version)
	case Reverted:
		DeleteVersionSQL(&batch, version)
	}
	if _, err = conn.PgConn().ExecBatch(ctx, &batch).ReadAll(); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Repaired migration history:", version, "=>", status)
	return nil
}

func InsertVersionSQL(batch *pgconn.Batch, version string) {
	updateVersionSQL(batch, INSERT_MIGRATION_VERSION, version)
}

func DeleteVersionSQL(batch *pgconn.Batch, version string) {
	updateVersionSQL(batch, DELETE_MIGRATION_VERSION, version)
}

func updateVersionSQL(batch *pgconn.Batch, sql, version string) {
	batch.ExecParams(
		sql,
		[][]byte{[]byte(version)},
		[]uint32{pgtype.TextOID},
		[]int16{pgtype.TextFormatCode},
		nil,
	)
}
