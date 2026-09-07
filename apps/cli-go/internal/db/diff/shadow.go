package diff

import (
	"context"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
)

// ShadowSource is a provisioned shadow database, left running for an external
// caller to diff against and then remove. It mirrors the shadow that
// DiffDatabase prepares as the diff "source".
type ShadowSource struct {
	// Container is the shadow database container id; the caller MUST remove it
	// (e.g. `docker rm -f <id>`) when the diff completes.
	Container string
	// Source is the connection config for the diff source (the shadow with the
	// platform baseline + local migrations applied).
	Source pgconn.Config
	// TargetOverride, when non-nil, replaces the diff target with a second
	// shadow database (contrib_regression with declarative schemas applied).
	TargetOverride *pgconn.Config
}

// PrepareShadowSource provisions the shadow database that DiffDatabase diffs
// against, but returns it running instead of diffing + removing. targetLocal
// mirrors utils.IsLocalDatabase(config). On error the shadow container is
// removed. Declared schemas are applied with the migra seed path; pg-delta
// apply lives in the TypeScript CLI.
func PrepareShadowSource(ctx context.Context, targetLocal bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (ShadowSource, error) {
	shadow, err := CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return ShadowSource{}, err
	}
	ok := false
	defer func() {
		if !ok {
			utils.DockerRemove(shadow)
		}
	}()
	if err := start.WaitForHealthyService(ctx, utils.Config.Db.HealthTimeout, shadow); err != nil {
		return ShadowSource{}, err
	}
	if err := MigrateShadowDatabase(ctx, shadow, fsys, options...); err != nil {
		return ShadowSource{}, err
	}
	shadowConfig := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	var targetOverride *pgconn.Config
	if targetLocal {
		declared, err := loadDeclaredSchemas(fsys)
		if err != nil {
			return ShadowSource{}, err
		}
		if len(declared) > 0 {
			override := shadowConfig
			override.Database = "contrib_regression"
			if err := migrateBaseDatabase(ctx, override, declared, fsys, options...); err != nil {
				return ShadowSource{}, err
			}
			targetOverride = &override
		}
	}
	ok = true
	return ShadowSource{Container: shadow, Source: shadowConfig, TargetOverride: targetOverride}, nil
}
