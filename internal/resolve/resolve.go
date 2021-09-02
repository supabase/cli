package resolve

import (
	"context"
	"errors"
	"fmt"
	"os"

	pgx "github.com/jackc/pgx/v4"
)

var ctx = context.TODO()

func ResolveApplied(timestamp string) error {
	url := os.Getenv("SUPABASE_DEPLOY_DB_URL")
	if url == "" {
		return errors.New("❌ SUPABASE_DEPLOY_DB_URL is not set.")
	}

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	if _, err := conn.Query(
		ctx,
		"INSERT INTO supabase_migrations.schema_migrations(version) VALUES ($1)",
		timestamp,
	); err != nil {
		return err
	}

	fmt.Println("Finished supabase resolve.")

	return nil
}

func ResolveRolledBack(timestamp string) error {
	url := os.Getenv("SUPABASE_DEPLOY_DB_URL")
	if url == "" {
		return errors.New("❌ SUPABASE_DEPLOY_DB_URL is not set.")
	}

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	if _, err := conn.Query(
		ctx,
		"DELETE FROM supabase_migrations.schema_migrations WHERE version = $1",
		timestamp,
	); err != nil {
		return err
	}

	fmt.Println("Finished supabase resolve.")

	return nil
}
