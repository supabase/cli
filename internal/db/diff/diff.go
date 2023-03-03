package diff

import (
	"context"
	_ "embed"
	"fmt"
	"os"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
)

var warnDiff = `WARNING: The diff tool is not foolproof, so you may need to manually rearrange and modify the generated migration.
Run ` + utils.Aqua("supabase db reset") + ` to verify that the new migration does not generate errors.`

func SaveDiff(out, file string, fsys afero.Fs) error {
	if len(out) < 2 {
		fmt.Fprintln(os.Stderr, "No changes found")
	} else if len(file) > 0 {
		path := new.GetMigrationPath(file)
		if err := afero.WriteFile(fsys, path, []byte(out), 0644); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, warnDiff)
	} else {
		fmt.Println(out)
	}
	return nil
}

func Run(ctx context.Context, schema []string, file string, config pgconn.Config, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}
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
	shadow, err := CreateShadowDatabase(ctx)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(shadow)
	if err := MigrateShadowDatabase(ctx, fsys); err != nil {
		return err
	}

	p.Send(utils.StatusMsg("Diffing local database with current migrations..."))

	// 2. Diff local db (source) with shadow db (target), print it.
	source := "postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres"
	if len(config.Password) == 0 {
		config.Host = shadow[:12]
		config.Port = 5432
		config.User = "postgres"
		config.Password = "postgres"
		config.Database = "postgres"
	}
	target := utils.ToPostgresURL(config)
	output, err = DiffSchema(ctx, source, target, schema, p)
	return err
}

func DiffSchema(ctx context.Context, source, target string, schema []string, p utils.Program) (string, error) {
	stream := utils.NewDiffStream(p)
	args := []string{"--json-diff", source, target}
	if len(schema) == 0 {
		if err := utils.DockerRunOnceWithStream(
			ctx,
			utils.DifferImage,
			nil,
			args,
			nil,
			"",
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
			utils.DifferImage,
			nil,
			append([]string{"--schema", s}, args...),
			nil,
			"",
			stream.Stdout(),
			stream.Stderr(),
		); err != nil {
			return "", err
		}
	}
	diffBytes, err := stream.Collect()
	return string(diffBytes), err
}
