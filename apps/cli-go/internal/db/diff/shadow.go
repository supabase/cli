package diff

import (
	"context"
	"time"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/pkg/errors"
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

// PgDeltaNextShadow is a provisioned shadow container exposing both database
// states needed by the native pg-delta engine. Migrated contains the platform
// baseline plus local migrations. Scratch is an empty sibling database owned
// by pg-delta's declarative planner while it loads the desired schema files.
type PgDeltaNextShadow struct {
	// Container is left running for the caller, which MUST remove it after use.
	Container string
	Migrated  pgconn.Config
	Scratch   pgconn.Config
}

type pgDeltaNextShadowDependencies struct {
	create        func(context.Context, uint16) (string, error)
	wait          func(context.Context, time.Duration, ...string) error
	migrate       func(context.Context, string, afero.Fs, ...func(*pgx.ConnConfig)) error
	createScratch func(context.Context, ...func(*pgx.ConnConfig)) error
	remove        func(string)
}

const createPgDeltaNextScratch = "CREATE DATABASE pgdelta_declarative TEMPLATE template0"

// createPgDeltaNextScratchDatabase creates the empty same-cluster database that
// planSchemaFiles owns. Using template0 guarantees it does not inherit the
// platform baseline or local migrations from postgres.
func createPgDeltaNextScratchDatabase(ctx context.Context, options ...func(*pgx.ConnConfig)) error {
	conn, err := ConnectShadowDatabase(ctx, 10*time.Second, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, createPgDeltaNextScratch); err != nil {
		return errors.Wrap(err, "failed to create pg-delta declarative scratch database")
	}
	return nil
}

// PreparePgDeltaNextShadow provisions the migrated target and an empty live
// sibling database used by the native pg-delta declarative planner. It never
// loads or applies the legacy declarative schemas. On failure, the container is
// removed best-effort without replacing the provisioning error.
func PreparePgDeltaNextShadow(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (PgDeltaNextShadow, error) {
	return preparePgDeltaNextShadow(ctx, fsys, pgDeltaNextShadowDependencies{
		create:        CreateShadowDatabase,
		wait:          start.WaitForHealthyService,
		migrate:       MigrateShadowDatabase,
		createScratch: createPgDeltaNextScratchDatabase,
		remove:        utils.DockerRemove,
	}, options...)
}

func preparePgDeltaNextShadow(ctx context.Context, fsys afero.Fs, dependencies pgDeltaNextShadowDependencies, options ...func(*pgx.ConnConfig)) (PgDeltaNextShadow, error) {
	shadow, err := dependencies.create(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return PgDeltaNextShadow{}, err
	}
	ok := false
	defer func() {
		if !ok {
			dependencies.remove(shadow)
		}
	}()
	if err := dependencies.wait(ctx, utils.Config.Db.HealthTimeout, shadow); err != nil {
		return PgDeltaNextShadow{}, err
	}
	if err := dependencies.migrate(ctx, shadow, fsys, options...); err != nil {
		return PgDeltaNextShadow{}, err
	}
	if err := dependencies.createScratch(ctx, options...); err != nil {
		return PgDeltaNextShadow{}, err
	}
	migrated := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	scratch := migrated
	scratch.Database = "pgdelta_declarative"
	ok = true
	return PgDeltaNextShadow{Container: shadow, Migrated: migrated, Scratch: scratch}, nil
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
			if shouldApplyDeclarativeWithPgDelta(usePgDelta) {
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
