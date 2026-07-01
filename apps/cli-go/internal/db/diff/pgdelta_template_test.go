package diff

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// lastCodeLine returns the final non-blank, non-comment line of a script.
func lastCodeLine(script string) string {
	lines := strings.Split(script, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		return line
	}
	return ""
}

// Every pg-delta edge-runtime script must force the worker's event loop closed
// once its output has been written. The pg connection pool can leave keepalive
// handles registered even after close() resolves; if the worker never exits,
// the container never stops and the CLI — which streams the container logs with
// Follow:true — blocks forever following them, hanging declarative sync at 0%
// CPU (supabase/pg-toolbelt#312). The success path must terminate
// unconditionally rather than rely on the event loop draining on its own, so
// guard against the force-close being dropped from any template's success path.
func TestPgDeltaScriptsForceCloseOnSuccess(t *testing.T) {
	scripts := map[string]string{
		"pgdelta.ts":                    pgDeltaScript,
		"pgdelta_declarative_export.ts": pgDeltaDeclarativeExportScript,
		"pgdelta_catalog_export.ts":     pgDeltaCatalogExportScript,
	}
	for name, script := range scripts {
		t.Run(name, func(t *testing.T) {
			require.NotEmpty(t, script)
			// The terminating statement runs on the success path (the catch
			// branch no longer re-throws), so the worker is torn down whether
			// or not the body succeeded.
			assert.Equal(t, `throw new Error("");`, lastCodeLine(script),
				"success path must force the Edge Runtime worker to exit so the container stops")
		})
	}
}
