package diff

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/pgcache"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

type linkedConfigResolver func(context.Context, afero.Fs) (pgconn.Config, error)
type migrationsRefResolver func(context.Context, afero.Fs, ...func(*pgx.ConnConfig)) (string, error)

func RunExplicit(ctx context.Context, fromRef, toRef string, schema []string, outputPath string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	source, err := resolveExplicitDatabaseRef(ctx, fromRef, fsys, resolveLinkedConfig, resolveMigrationsCatalogRef, options...)
	if err != nil {
		return err
	}
	target, err := resolveExplicitDatabaseRef(ctx, toRef, fsys, resolveLinkedConfig, resolveMigrationsCatalogRef, options...)
	if err != nil {
		return err
	}
	out, err := DiffPgDeltaRef(ctx, source, target, schema, pgDeltaFormatOptions(), options...)
	if err != nil {
		return err
	}
	if len(outputPath) > 0 {
		return writeOutput(out, outputPath, fsys)
	}
	fmt.Print(out)
	return nil
}

var validTargets = map[string]bool{"local": true, "linked": true, "migrations": true}

func resolveExplicitDatabaseRef(ctx context.Context, ref string, fsys afero.Fs, resolveLinked linkedConfigResolver, resolveMigrations migrationsRefResolver, options ...func(*pgx.ConnConfig)) (string, error) {
	if !validTargets[ref] && !isPostgresURL(ref) {
		return "", errors.Errorf("unknown target %q: must be one of 'local', 'linked', 'migrations', or a postgres:// URL", ref)
	}
	switch ref {
	case "local":
		return utils.ToPostgresURL(pgconn.Config{
			Host:     utils.Config.Hostname,
			Port:     utils.Config.Db.Port,
			User:     "postgres",
			Password: utils.Config.Db.Password,
			Database: "postgres",
		}), nil
	case "linked":
		if resolveLinked == nil {
			resolveLinked = resolveLinkedConfig
		}
		config, err := resolveLinked(ctx, fsys)
		if err != nil {
			return "", err
		}
		return utils.ToPostgresURL(config), nil
	case "migrations":
		if resolveMigrations == nil {
			resolveMigrations = resolveMigrationsCatalogRef
		}
		return resolveMigrations(ctx, fsys, options...)
	default:
		return ref, nil
	}
}

func writeOutput(out, outputPath string, fsys afero.Fs) error {
	return utils.WriteFile(outputPath, []byte(out), fsys)
}

func resolveLinkedConfig(ctx context.Context, fsys afero.Fs) (pgconn.Config, error) {
	if err := flags.LoadProjectRef(fsys); err != nil {
		return pgconn.Config{}, err
	}
	if err := flags.LoadConfig(fsys); err != nil {
		return pgconn.Config{}, err
	}
	return flags.NewDbConfigWithPassword(ctx, flags.ProjectRef)
}

func resolveMigrationsCatalogRef(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (string, error) {
	hash, err := pgcache.HashMigrations(fsys)
	if err != nil {
		return "", err
	}
	if cachePath, ok, err := pgcache.ResolveMigrationCatalogPath(fsys, hash, "local"); err != nil {
		return "", err
	} else if ok {
		return cachePath, nil
	}
	shadow, err := CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return "", err
	}
	defer utils.DockerRemove(shadow)
	if err := start.WaitForHealthyService(ctx, utils.Config.Db.HealthTimeout, shadow); err != nil {
		utils.DockerRemove(shadow)
		return "", err
	}
	if err := MigrateShadowDatabase(ctx, shadow, fsys, options...); err != nil {
		return "", err
	}
	shadowConfig := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	snapshot, err := ExportCatalogPgDelta(ctx, utils.ToPostgresURL(shadowConfig), "postgres", options...)
	if err != nil {
		return "", err
	}
	cachePath, err := pgcache.WriteMigrationCatalogSnapshot(fsys, "local", hash, snapshot)
	if err != nil {
		return "", err
	}
	return cachePath, nil
}
