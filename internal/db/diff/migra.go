package diff

import (
	"bytes"
	"context"
	_ "embed"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

//go:embed templates/migra.sh
var diffSchemaScript string

// Diffs local database schema against shadow, dumps output to stdout.
func DiffSchemaMigra(ctx context.Context, source, target string, schema []string) (string, error) {
	env := []string{"SOURCE=" + source, "TARGET=" + target}
	// Passing in script string means command line args must be set manually, ie. "$@"
	args := "set -- " + strings.Join(schema, " ") + ";"
	cmd := []string{"/bin/sh", "-c", args + diffSchemaScript}
	var out, stderr bytes.Buffer
	if err := utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: config.Images.Migra,
			Env:   env,
			Cmd:   cmd,
		},
		container.HostConfig{
			NetworkMode: network.NetworkHost,
		},
		network.NetworkingConfig{},
		"",
		&out,
		&stderr,
	); err != nil {
		return "", errors.Errorf("error diffing schema: %w:\n%s", err, stderr.String())
	}
	return out.String(), nil
}
