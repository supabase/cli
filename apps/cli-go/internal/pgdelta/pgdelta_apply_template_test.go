package pgdelta

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The declarative-apply script connects to TARGET and must force the worker's
// event loop closed once it has written its result JSON. applyDeclarativeSchema
// can leave connection keepalive handles registered, and if the worker never
// exits the container never stops — the CLI, which follows the container logs
// with Follow:true, then hangs indefinitely at 0% CPU (supabase/pg-toolbelt#312).
// The success path must terminate unconditionally, so guard against the
// force-close being dropped.
func TestDeclarativeApplyScriptForceClosesOnSuccess(t *testing.T) {
	require.NotEmpty(t, pgDeltaDeclarativeApplyScript)

	lines := strings.Split(pgDeltaDeclarativeApplyScript, "\n")
	last := ""
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		last = line
		break
	}
	assert.Equal(t, `throw new Error("");`, last,
		"success path must force the Edge Runtime worker to exit so the container stops")
}
