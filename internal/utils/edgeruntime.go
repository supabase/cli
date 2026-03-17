package utils

import (
	"bytes"
	"context"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
)

// RunEdgeRuntimeScript executes a TypeScript program inside the configured Edge
// Runtime container and streams stdout/stderr back to the caller.
func RunEdgeRuntimeScript(ctx context.Context, env []string, script string, binds []string, errPrefix string, stdout, stderr *bytes.Buffer) error {
	cmd := []string{"edge-runtime", "start", "--main-service=."}
	cmdString := strings.Join(cmd, " ")
	entrypoint := []string{"sh", "-c", `cat <<'EOF' > index.ts && ` + cmdString + `
` + script + `
EOF
`}
	if err := DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image:      Config.EdgeRuntime.Image,
			Env:        env,
			Entrypoint: entrypoint,
		},
		container.HostConfig{
			Binds:       binds,
			NetworkMode: network.NetworkHost,
		},
		network.NetworkingConfig{},
		"",
		stdout,
		stderr,
	); err != nil && !strings.HasPrefix(stderr.String(), "main worker has been destroyed") {
		return errors.Errorf("%s: %w:\n%s", errPrefix, err, stderr.String())
	}
	return nil
}
