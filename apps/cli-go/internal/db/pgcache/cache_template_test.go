package pgcache

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The migrations-catalog cache script (db start / db push with pg-delta caching)
// opens a connection pool and must force the worker's event loop closed once it
// has written its snapshot. If a keepalive handle lingers after close() resolves
// the worker never exits, so the container never stops and the CLI — which
// follows the container logs with Follow:true — hangs indefinitely at 0% CPU
// (supabase/pg-toolbelt#312). Guard against the success-path force-close being
// dropped.
func TestPgDeltaCatalogExportScriptForceClosesOnSuccess(t *testing.T) {
	require.NotEmpty(t, pgDeltaCatalogExportTS)

	lines := strings.Split(pgDeltaCatalogExportTS, "\n")
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
