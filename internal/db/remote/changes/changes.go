package changes

import (
	"context"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/utils"
)

var output string

func Run(ctx context.Context, username, password, database string, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
	}

	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		return run(p, ctx, username, password, database, fsys)
	}); err != nil {
		return err
	}

	return diff.SaveDiff(output, "", fsys)
}

func run(p utils.Program, ctx context.Context, username, password, database string, fsys afero.Fs) error {
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	host := utils.GetSupabaseDbHost(projectRef)

	p.Send(utils.StatusMsg("Pulling images..."))

	for _, image := range []string{utils.DbImage, utils.DifferImage} {
		if err := utils.DockerPullImageIfNotCached(ctx, image); err != nil {
			return err
		}
	}

	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	{
		conn, err := utils.ConnectRemotePostgres(ctx, username, password, database, host)
		if err != nil {
			return err
		}
		defer conn.Close(context.Background())
		if err := commit.AssertRemoteInSync(ctx, conn, fsys); err != nil {
			return err
		}
	}

	// 2. Create shadow db and run migrations.
	p.Send(utils.StatusMsg("Creating shadow database..."))

	shadow, err := diff.CreateShadowDatabase(ctx)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(shadow)
	if err := diff.MigrateShadowDatabase(ctx, fsys); err != nil {
		return err
	}

	// 3. Diff remote db (source) & shadow db (target) and print it.
	p.Send(utils.StatusMsg("Generating changes on the remote database since the last migration..."))

	src := fmt.Sprintf(`dbname='%s' user='%s' host='%s' password='%s'`, database, username, host, password)
	dst := fmt.Sprintf(`dbname=postgres user=postgres host='%s' password=postgres`, shadow[:12])
	output, err = diff.DiffSchema(ctx, src, dst, nil, p)
	return err
}
