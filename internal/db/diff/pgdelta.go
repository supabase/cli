package diff

import (
	"bytes"
	"context"
	_ "embed"
	"io"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/gen/types"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/pgdelta.ts
var pgDeltaScript string

func DiffPgDelta(ctx context.Context, source, target pgconn.Config, schema []string, options ...func(*pgx.ConnConfig)) (string, error) {
	env := []string{
		"SOURCE=" + utils.ToPostgresURL(source),
	}
	if ca, err := types.GetRootCA(ctx, utils.ToPostgresURL(target), options...); err != nil {
		return "", err
	} else if len(ca) > 0 {
		target.RuntimeParams["sslmode"] = "require"
		env = append(env,
			"TARGET="+utils.ToPostgresURL(target),
			"PGDELTA_TARGET_SSLROOTCERT="+ca,
		)
	}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	}
	var out bytes.Buffer
	if err := diffWithStream(ctx, env, pgDeltaScript, &out); err != nil {
		return "", err
	}
	return out.String(), nil
}

func diffWithStream(ctx context.Context, env []string, script string, stdout io.Writer) error {
	cmd := []string{"edge-runtime", "start", "--main-service=."}
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
	cmdString := strings.Join(cmd, " ")
	entrypoint := []string{"sh", "-c", `cat <<'EOF' > index.ts && ` + cmdString + `
` + script + `
EOF
`}
	var stderr bytes.Buffer
	if err := utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image:      utils.Config.EdgeRuntime.Image,
			Env:        env,
			Entrypoint: entrypoint,
		},
		container.HostConfig{
			Binds:       []string{utils.EdgeRuntimeId + ":/root/.cache/deno:rw"},
			NetworkMode: network.NetworkHost,
		},
		network.NetworkingConfig{},
		"",
		stdout,
		&stderr,
	); err != nil && !strings.HasPrefix(stderr.String(), "main worker has been destroyed") {
		return errors.Errorf("error diffing schema: %w:\n%s", err, stderr.String())
	}
	return nil
}
