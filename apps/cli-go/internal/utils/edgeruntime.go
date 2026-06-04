package utils

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/spf13/viper"
)

// getFreeHostPort asks the OS for an unused TCP port on the host.
func getFreeHostPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, errors.Errorf("failed to allocate free port: %w", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

// EdgeRuntimeStartCmd builds the base command for launching a one-shot Edge
// Runtime script. The runtime's HTTP listener is bound to a free host port so
// concurrent or leftover containers (which share the host network namespace
// because diff containers run with NetworkMode=host) don't collide on the
// edge-runtime default port, which surfaces as "Address already in use (os
// error 98)". See https://github.com/supabase/cli/issues/5407.
func EdgeRuntimeStartCmd() []string {
	cmd := []string{"edge-runtime", "start", "--main-service=."}
	// Skip the flag on the rare allocation failure to preserve prior behavior.
	if port, err := getFreeHostPort(); err == nil {
		cmd = append(cmd, fmt.Sprintf("--port=%d", port))
	}
	return cmd
}

// RunEdgeRuntimeScript executes a TypeScript program inside the configured Edge
// Runtime container and streams stdout/stderr back to the caller.
func RunEdgeRuntimeScript(ctx context.Context, env []string, script string, binds []string, errPrefix string, stdout, stderr *bytes.Buffer) error {
	cmd := EdgeRuntimeStartCmd()
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
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
	); err != nil && !strings.Contains(stderr.String(), "main worker has been destroyed") {
		return errors.Errorf("%s: %w:\n%s", errPrefix, err, stderr.String())
	}
	return nil
}
