package diff

import (
	"bytes"
	"context"
	_ "embed"
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

//go:embed templates/delta.ts
var pgDeltaScript string

func DiffPgDelta(ctx context.Context, source, target pgconn.Config, schema []string, options ...func(*pgx.ConnConfig)) (string, error) {
	env := []string{
		"SOURCE=" + utils.ToPostgresURL(source),
		"TARGET=" + utils.ToPostgresURL(target),
	}
	if ca, err := types.GetRootCA(ctx, utils.ToPostgresURL(target), options...); err != nil {
		return "", err
	} else if len(ca) > 0 {
		env = append(env, "SSL_CA="+ca)
	}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	} else {
		env = append(env, "EXCLUDED_SCHEMAS="+strings.Join(managedSchemas, ","))
	}
	cmd := []string{"edge-runtime", "start", "--main-service=."}
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
	cmdString := strings.Join(cmd, " ")
	entrypoint := []string{"sh", "-c", `cat <<'EOF' > index.ts && ` + cmdString + `
` + pgDeltaScript + `
EOF
`}
	var out, stderr bytes.Buffer
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
		&out,
		&stderr,
	); err != nil && !strings.HasPrefix(stderr.String(), "main worker has been destroyed") {
		return "", errors.Errorf("error diffing schema: %w:\n%s", err, stderr.String())
	}
	return out.String(), nil
}
