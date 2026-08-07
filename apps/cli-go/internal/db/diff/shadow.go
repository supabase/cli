package diff

import (
	"context"
	"fmt"
	"math"
	"time"

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

// PgDeltaNextShadowDatabase is one isolated database state used by pg-delta.
// Container is left running for the caller, which MUST remove it after use.
type PgDeltaNextShadowDatabase struct {
	Container string
	Config    pgconn.Config
}

// PgDeltaNextShadow contains the two isolated clusters used by the native
// pg-delta engine. Migrations has the platform baseline plus local migrations;
// Declarative has the same platform baseline and local configuration, ready for
// pg-delta to load declarative SQL into postgres.
type PgDeltaNextShadow struct {
	Migrations  PgDeltaNextShadowDatabase
	Declarative PgDeltaNextShadowDatabase
}

type pgDeltaNextShadowDependencies struct {
	freePort func() (int, error)
	create   func(context.Context, uint16) (string, error)
	wait     func(context.Context, time.Duration, ...string) error
	migrate  func(context.Context, string, afero.Fs, ...func(*pgx.ConnConfig)) error
	setup    func(context.Context, string, afero.Fs, ...func(*pgx.ConnConfig)) error
	remove   func(string)
}

// PreparePgDeltaNextShadow provisions isolated migrated and declarative
// clusters. On failure, every container created so far is removed best-effort
// without replacing the provisioning error.
func PreparePgDeltaNextShadow(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (PgDeltaNextShadow, error) {
	return preparePgDeltaNextShadow(ctx, fsys, pgDeltaNextShadowDependencies{
		freePort: utils.GetFreeHostPort,
		create:   CreateShadowDatabase,
		wait:     start.WaitForHealthyService,
		migrate:  MigrateShadowDatabase,
		setup:    SetupPgDeltaNextDeclarativeShadowDatabase,
		remove:   utils.DockerRemove,
	}, options...)
}

func preparePgDeltaNextShadow(ctx context.Context, fsys afero.Fs, dependencies pgDeltaNextShadowDependencies, options ...func(*pgx.ConnConfig)) (PgDeltaNextShadow, error) {
	var containers []string
	ok := false
	defer func() {
		if !ok {
			for _, container := range containers {
				dependencies.remove(container)
			}
		}
	}()

	migrationsPort, err := allocatePgDeltaNextPort(dependencies.freePort, 0)
	if err != nil {
		return PgDeltaNextShadow{}, err
	}
	migrationsContainer, err := dependencies.create(ctx, migrationsPort)
	if migrationsContainer != "" {
		containers = append(containers, migrationsContainer)
	}
	if err != nil {
		return PgDeltaNextShadow{}, err
	}
	if err := dependencies.wait(ctx, utils.Config.Db.HealthTimeout, migrationsContainer); err != nil {
		return PgDeltaNextShadow{}, err
	}
	if err := dependencies.migrate(ctx, migrationsContainer, fsys, append(options, withShadowPort(migrationsPort))...); err != nil {
		return PgDeltaNextShadow{}, err
	}

	declarativePort, err := allocatePgDeltaNextPort(dependencies.freePort, migrationsPort)
	if err != nil {
		return PgDeltaNextShadow{}, err
	}
	declarativeContainer, err := dependencies.create(ctx, declarativePort)
	if declarativeContainer != "" {
		containers = append(containers, declarativeContainer)
	}
	if err != nil {
		return PgDeltaNextShadow{}, err
	}
	if err := dependencies.wait(ctx, utils.Config.Db.HealthTimeout, declarativeContainer); err != nil {
		return PgDeltaNextShadow{}, err
	}
	if err := dependencies.setup(ctx, declarativeContainer, fsys, append(options, withShadowPort(declarativePort))...); err != nil {
		return PgDeltaNextShadow{}, err
	}

	ok = true
	return PgDeltaNextShadow{
		Migrations: PgDeltaNextShadowDatabase{
			Container: migrationsContainer,
			Config:    pgDeltaNextShadowConfig(migrationsPort),
		},
		Declarative: PgDeltaNextShadowDatabase{
			Container: declarativeContainer,
			Config:    pgDeltaNextShadowConfig(declarativePort),
		},
	}, nil
}

func allocatePgDeltaNextPort(freePort func() (int, error), excluded uint16) (uint16, error) {
	for range 10 {
		port, err := freePort()
		if err != nil {
			return 0, err
		}
		if port <= 0 || port > math.MaxUint16 {
			return 0, fmt.Errorf("allocated host port %d is outside the valid range", port)
		}
		if uint16(port) != excluded {
			return uint16(port), nil
		}
	}
	return 0, fmt.Errorf("failed to allocate a host port distinct from %d", excluded)
}

func withShadowPort(port uint16) func(*pgx.ConnConfig) {
	return func(config *pgx.ConnConfig) {
		config.Port = port
	}
}

func pgDeltaNextShadowConfig(port uint16) pgconn.Config {
	return pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     port,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
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
