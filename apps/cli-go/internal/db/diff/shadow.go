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
}

// PgDeltaNextShadowDatabase is one isolated database state used by pg-delta.
// Container is left running for the caller, which MUST remove it after use.
type PgDeltaNextShadowDatabase struct {
	Container string
	Config    pgconn.Config
}

// PgDeltaNextPlanShadow contains the two isolated clusters used by the native
// pg-delta engine. Migrations has the platform baseline plus local migrations;
// Declarative has the same platform baseline and local configuration, ready for
// pg-delta to load declarative SQL into postgres.
type PgDeltaNextPlanShadow struct {
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

// PreparePgDeltaNextMigrationsShadow provisions only the migrated cluster used
// by database diffs. On failure, every container created so far is removed
// best-effort without replacing the provisioning error.
func PreparePgDeltaNextMigrationsShadow(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (PgDeltaNextShadowDatabase, error) {
	return preparePgDeltaNextMigrationsShadow(ctx, fsys, pgDeltaNextShadowDependencies{
		freePort: utils.GetFreeHostPort,
		create:   CreateShadowDatabase,
		wait:     start.WaitForHealthyService,
		migrate:  MigratePgDeltaNextShadowDatabase,
		setup:    SetupPgDeltaNextDeclarativeShadowDatabase,
		remove:   utils.DockerRemove,
	}, options...)
}

// PreparePgDeltaNextPlanShadow provisions isolated migrated and declarative
// clusters for a declarative plan.
func PreparePgDeltaNextPlanShadow(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (PgDeltaNextPlanShadow, error) {
	return preparePgDeltaNextPlanShadow(ctx, fsys, pgDeltaNextShadowDependencies{
		freePort: utils.GetFreeHostPort,
		create:   CreateShadowDatabase,
		wait:     start.WaitForHealthyService,
		migrate:  MigratePgDeltaNextShadowDatabase,
		setup:    SetupPgDeltaNextDeclarativeShadowDatabase,
		remove:   utils.DockerRemove,
	}, options...)
}

func preparePgDeltaNextMigrationsShadow(ctx context.Context, fsys afero.Fs, dependencies pgDeltaNextShadowDependencies, options ...func(*pgx.ConnConfig)) (PgDeltaNextShadowDatabase, error) {
	return preparePgDeltaNextShadowDatabase(ctx, fsys, 0, dependencies, dependencies.migrate, options...)
}

func preparePgDeltaNextPlanShadow(ctx context.Context, fsys afero.Fs, dependencies pgDeltaNextShadowDependencies, options ...func(*pgx.ConnConfig)) (PgDeltaNextPlanShadow, error) {
	migrations, err := preparePgDeltaNextMigrationsShadow(ctx, fsys, dependencies, options...)
	if err != nil {
		return PgDeltaNextPlanShadow{}, err
	}
	ok := false
	defer func() {
		if !ok {
			dependencies.remove(migrations.Container)
		}
	}()

	declarative, err := preparePgDeltaNextShadowDatabase(ctx, fsys, migrations.Config.Port, dependencies, dependencies.setup, options...)
	if err != nil {
		return PgDeltaNextPlanShadow{}, err
	}

	ok = true
	return PgDeltaNextPlanShadow{
		Migrations:  migrations,
		Declarative: declarative,
	}, nil
}

func preparePgDeltaNextShadowDatabase(
	ctx context.Context,
	fsys afero.Fs,
	excludedPort uint16,
	dependencies pgDeltaNextShadowDependencies,
	initialize func(context.Context, string, afero.Fs, ...func(*pgx.ConnConfig)) error,
	options ...func(*pgx.ConnConfig),
) (PgDeltaNextShadowDatabase, error) {
	port, err := allocatePgDeltaNextPort(dependencies.freePort, excludedPort)
	if err != nil {
		return PgDeltaNextShadowDatabase{}, err
	}
	container, err := dependencies.create(ctx, port)
	ok := false
	defer func() {
		if !ok && container != "" {
			dependencies.remove(container)
		}
	}()
	if err != nil {
		return PgDeltaNextShadowDatabase{}, err
	}
	if err := dependencies.wait(ctx, utils.Config.Db.HealthTimeout, container); err != nil {
		return PgDeltaNextShadowDatabase{}, err
	}
	if err := initialize(ctx, container, fsys, append(options, withShadowPort(port))...); err != nil {
		return PgDeltaNextShadowDatabase{}, err
	}

	ok = true
	return PgDeltaNextShadowDatabase{
		Container: container,
		Config:    pgDeltaNextShadowConfig(port),
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
// caller can run the differ itself. On error the shadow container is removed.
func PrepareShadowSource(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (ShadowSource, error) {
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
	ok = true
	return ShadowSource{Container: shadow, Source: shadowConfig}, nil
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
