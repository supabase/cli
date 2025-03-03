package diff

import (
	"context"
	_ "embed"
	"fmt"
	"os"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

var warnDiff = `WARNING: The diff tool is not foolproof, so you may need to manually rearrange and modify the generated migration.
Run ` + utils.Aqua("supabase db reset") + ` to verify that the new migration does not generate errors.`

func SaveDiff(out, file string, fsys afero.Fs) error {
	if len(out) < 2 {
		fmt.Fprintln(os.Stderr, "No schema changes found")
	} else if len(file) > 0 {
		path := new.GetMigrationPath(utils.GetCurrentTimestamp(), file)
		if err := utils.WriteFile(path, []byte(out), fsys); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, warnDiff)
	} else {
		fmt.Println(out)
	}
	return nil
}

func RunPgAdmin(ctx context.Context, schema []string, file string, config pgconn.Config, fsys afero.Fs) error {
	// Sanity checks.
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
	}

	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		return run(p, ctx, schema, config, fsys)
	}); err != nil {
		return err
	}

	return SaveDiff(output, file, fsys)
}

var output string

func run(p utils.Program, ctx context.Context, schema []string, config pgconn.Config, fsys afero.Fs) error {
	p.Send(utils.StatusMsg("Creating shadow database..."))

	// 1. Create shadow db and run migrations
	shadow, err := CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(shadow)
	if err := start.WaitForHealthyService(ctx, start.HealthTimeout, shadow); err != nil {
		return err
	}
	if err := MigrateShadowDatabase(ctx, shadow, fsys); err != nil {
		return err
	}

	p.Send(utils.StatusMsg("Diffing local database with current migrations..."))

	// 2. Diff local db (source) with shadow db (target), print it.
	source := utils.ToPostgresURL(config)
	target := fmt.Sprintf("postgresql://postgres:postgres@127.0.0.1:%d/postgres", utils.Config.Db.ShadowPort)
	output, err = DiffSchemaPgAdmin(ctx, source, target, schema, p)
	return err
}

func DiffSchemaPgAdmin(ctx context.Context, source, target string, schema []string, p utils.Program) (string, error) {
	stream := utils.NewDiffStream(p)
	args := []string{"--json-diff", source, target}
	if len(schema) == 0 {
		if err := utils.DockerRunOnceWithStream(
			ctx,
			config.Images.Differ,
			nil,
			args,
			stream.Stdout(),
			stream.Stderr(),
		); err != nil {
			return "", err
		}
	}
	for _, s := range schema {
		p.Send(utils.StatusMsg("Diffing schema: " + s))
		if err := utils.DockerRunOnceWithStream(
			ctx,
			config.Images.Differ,
			nil,
			append([]string{"--schema", s}, args...),
			stream.Stdout(),
			stream.Stderr(),
		); err != nil {
			return "", err
		}
	}
	diffBytes, err := stream.Collect()
	return string(diffBytes), err
}
