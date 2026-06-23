package diff

import (
	"context"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/pgdelta"
	"github.com/supabase/cli/internal/utils"
)

// ShadowSource is a provisioned shadow database, left running for an external
// caller (the native-TypeScript db diff/pull commands) to diff against and then
// remove. It mirrors the shadow that DiffDatabase prepares as the diff "source".
type ShadowSource struct {
	// Container is the shadow database container id; the caller MUST remove it
	// (e.g. `docker rm -f <id>`) when the diff completes.
	Container string
	// Source is the connection config for the diff source (the shadow with the
	// platform baseline + local migrations applied).
	Source pgconn.Config
	// TargetOverride, when non-nil, replaces the diff target with a second shadow
	// database (contrib_regression with declarative schemas applied). Mirrors
	// DiffDatabase's local-target declarative branch, where the user's local
	// database is not diffed at all.
	TargetOverride *pgconn.Config
}

// PrepareShadowSource provisions the shadow database that DiffDatabase diffs
// against, but returns it running instead of diffing + removing, so a native
// caller can run the differ itself. targetLocal mirrors
// utils.IsLocalDatabase(config) — the only target-derived input the shadow prep
// needs. usePgDelta selects the declarative-apply engine for the local-declared
// branch, matching DiffDatabase. On error the shadow container is removed.
func PrepareShadowSource(ctx context.Context, schema []string, targetLocal bool, usePgDelta bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (ShadowSource, error) {
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
			if usePgDelta {
				declDir := utils.GetDeclarativeDir()
				if exists, _ := afero.DirExists(fsys, declDir); exists {
					if err := pgdelta.ApplyDeclarative(ctx, override, fsys); err != nil {
						return ShadowSource{}, err
					}
				} else {
					if err := migrateBaseDatabase(ctx, override, declared, fsys, options...); err != nil {
						return ShadowSource{}, err
					}
				}
			} else {
				if err := migrateBaseDatabase(ctx, override, declared, fsys, options...); err != nil {
					return ShadowSource{}, err
				}
			}
			targetOverride = &override
		}
	}
	ok = true
	return ShadowSource{Container: shadow, Source: shadowConfig, TargetOverride: targetOverride}, nil
}

// PrepareRawShadow provisions a bare shadow database (created + healthy, with no
// platform baseline or migrations applied), left running for an external caller.
// Mirrors the shadow that pull.pullDeclarativePgDelta uses as the empty
// declarative-export source. On error the shadow container is removed.
func PrepareRawShadow(ctx context.Context) (ShadowSource, error) {
	shadow, err := CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return ShadowSource{}, err
	}
	if err := start.WaitForHealthyService(ctx, utils.Config.Db.HealthTimeout, shadow); err != nil {
		utils.DockerRemove(shadow)
		return ShadowSource{}, err
	}
	return ShadowSource{
		Container: shadow,
		Source: pgconn.Config{
			Host:     utils.Config.Hostname,
			Port:     utils.Config.Db.ShadowPort,
			User:     "postgres",
			Password: utils.Config.Db.Password,
			Database: "postgres",
		},
	}, nil
}
