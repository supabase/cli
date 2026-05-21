package utils

import (
	"bytes"
	"context"
	"fmt"
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

// RunEdgeRuntimeScript executes a TypeScript program inside the configured Edge
// Runtime container and streams stdout/stderr back to the caller.
func RunEdgeRuntimeScript(ctx context.Context, env []string, script string, binds []string, errPrefix string, stdout, stderr *bytes.Buffer, opts ...EdgeRuntimeOption) error {
	state := &edgeRuntimeOptions{}
	for _, opt := range opts {
		if opt != nil {
			opt(state)
		}
	}
	cmd := []string{"edge-runtime", "start", "--main-service=."}
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
	if err := DockerRunOnceWithConfig(
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
