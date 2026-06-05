package dump

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

func Run(ctx context.Context, path string, config pgconn.Config, dataOnly, roleOnly, dryRun bool, fsys afero.Fs, opts ...migration.DumpOptionFunc) error {
	// Initialize output stream
	outStream := (io.Writer)(os.Stdout)
	// Tee pg_dump's stderr so a failed connection (e.g. an IPv6-only host that is
	// unreachable from inside the container) can be classified into actionable
	// guidance instead of the bare "error running container: exit 1".
	var errBuf strings.Builder
	exec := captureExec(&errBuf)
	if dryRun {
		fmt.Fprintln(os.Stderr, "DRY RUN: *only* printing the pg_dump script to console.")
		exec = noExec
	} else if len(path) > 0 {
		f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
		if err != nil {
			return errors.Errorf("failed to open dump file: %w", err)
		}
		defer f.Close()
		outStream = f
	}
	db := "remote"
	if utils.IsLocalDatabase(config) {
		db = "local"
	}
	var err error
	if dataOnly {
		fmt.Fprintf(os.Stderr, "Dumping data from %s database...\n", db)
		err = migration.DumpData(ctx, config, outStream, exec, opts...)
	} else if roleOnly {
		fmt.Fprintf(os.Stderr, "Dumping roles from %s database...\n", db)
		err = migration.DumpRole(ctx, config, outStream, exec, opts...)
	} else {
		fmt.Fprintf(os.Stderr, "Dumping schemas from %s database...\n", db)
		err = migration.DumpSchema(ctx, config, outStream, exec, opts...)
	}
	if err != nil {
		// The container exit code hides why pg_dump failed; its stderr carries
		// the connection detail, so classify that for an actionable suggestion.
		utils.SetConnectSuggestion(errors.New(errBuf.String()))
	}
	return err
}

// captureExec wraps DockerExec so the container's stderr is teed into errBuf
// (in addition to the user's terminal) for post-failure classification.
func captureExec(errBuf *strings.Builder) migration.ExecFunc {
	return func(ctx context.Context, script string, env []string, w io.Writer) error {
		return dockerExec(ctx, script, env, w, io.MultiWriter(os.Stderr, errBuf))
	}
}

func noExec(ctx context.Context, script string, env []string, w io.Writer) error {
	envMap := make(map[string]string, len(env))
	for _, e := range env {
		index := strings.IndexByte(e, '=')
		if index < 0 {
			continue
		}
		envMap[e[:index]] = e[index+1:]
	}
	expanded := os.Expand(script, func(key string) string {
		// Bash variable expansion is unsupported:
		// https://github.com/golang/go/issues/47187
		parts := strings.Split(key, ":")
		value := envMap[parts[0]]
		// Escape double quotes in env vars
		return strings.ReplaceAll(value, `"`, `\"`)
	})
	fmt.Fprintln(w, expanded)
	return nil
}

func DockerExec(ctx context.Context, script string, env []string, w io.Writer) error {
	return dockerExec(ctx, script, env, w, os.Stderr)
}

func dockerExec(ctx context.Context, script string, env []string, w, errW io.Writer) error {
	return utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.Config.Db.Image,
			Env:   env,
			Cmd:   []string{"bash", "-c", script, "--"},
		},
		container.HostConfig{
			NetworkMode: network.NetworkHost,
		},
		network.NetworkingConfig{},
		"",
		w,
		errW,
	)
}
