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

// edgeRuntimeFile is a single file dropped into the edge-runtime container's
// working directory before the configured command is run.
type edgeRuntimeFile struct {
	name    string
	content string
}

// edgeRuntimeOptions accumulates the optional inputs assembled by
// EdgeRuntimeOption functions and consumed by RunEdgeRuntimeScript.
type edgeRuntimeOptions struct {
	extraFiles []edgeRuntimeFile
	extraEnv   []string
}

// EdgeRuntimeOption customizes a RunEdgeRuntimeScript invocation. The current
// shape (extra files dropped alongside index.ts, extra container env vars)
// covers the local-pg-delta use case; extend the option struct as new needs
// arrive instead of adding more positional arguments.
type EdgeRuntimeOption func(*edgeRuntimeOptions)

// WithExtraFile schedules an extra file alongside `index.ts` in the container.
// Useful for project-local config files (e.g. `.npmrc`, `deno.json`) that need
// to live next to the script Deno is asked to run.
func WithExtraFile(name, content string) EdgeRuntimeOption {
	return func(o *edgeRuntimeOptions) {
		o.extraFiles = append(o.extraFiles, edgeRuntimeFile{name: name, content: content})
	}
}

// WithExtraEnv appends container env entries in `KEY=value` form.
func WithExtraEnv(entries ...string) EdgeRuntimeOption {
	return func(o *edgeRuntimeOptions) {
		o.extraEnv = append(o.extraEnv, entries...)
	}
}

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
func RunEdgeRuntimeScript(ctx context.Context, env []string, script string, binds []string, errPrefix string, stdout, stderr *bytes.Buffer, opts ...EdgeRuntimeOption) error {
	state := &edgeRuntimeOptions{}
	for _, opt := range opts {
		if opt != nil {
			opt(state)
		}
	}
	cmd := EdgeRuntimeStartCmd()
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
	cmdString := strings.Join(cmd, " ")
	files := append([]edgeRuntimeFile{{name: "index.ts", content: script}}, state.extraFiles...)
	entrypoint := []string{"sh", "-c", buildEdgeRuntimeEntrypoint(files, cmdString)}
	combinedEnv := env
	if len(state.extraEnv) > 0 {
		combinedEnv = append(append([]string{}, env...), state.extraEnv...)
	}
	// Wait for the container to exit and then read its logs, rather than
	// following the log stream to detect completion. The edge-runtime worker is
	// forced to exit once the script flushes its output, but podman's
	// /logs?follow endpoint does not close when the container stops, so a
	// followed read (DockerRunOnceWithConfig) hangs the CLI forever
	// (supabase/pg-toolbelt#312). pg-delta script output is bounded, so reading
	// the log once after exit is safe.
	if err := DockerRunOnceWaitWithConfig(
		ctx,
		container.Config{
			Image:      Config.EdgeRuntime.Image,
			Env:        combinedEnv,
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

// buildEdgeRuntimeEntrypoint emits a `sh -c` body that writes each file via a
// here-document and then runs cmd. All heredoc openers are joined with `&&`
// before the bodies so bash stacks them in declaration order; each body is
// terminated with a unique sentinel so file contents can contain `EOF` safely.
func buildEdgeRuntimeEntrypoint(files []edgeRuntimeFile, cmd string) string {
	if len(files) == 0 {
		return cmd + "\n"
	}
	var head strings.Builder
	var bodies strings.Builder
	for i, f := range files {
		sentinel := fmt.Sprintf("__EDGE_RT_FILE_%d__", i)
		fmt.Fprintf(&head, "cat <<'%s' > %s && ", sentinel, f.name)
		fmt.Fprintf(&bodies, "%s\n%s\n", f.content, sentinel)
	}
	head.WriteString(cmd)
	head.WriteString("\n")
	head.WriteString(bodies.String())
	return head.String()
}
