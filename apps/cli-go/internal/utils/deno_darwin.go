//go:build darwin

package utils

import (
	"syscall"

	"github.com/go-errors/errors"
)

func getDenoAssetFileName() (string, error) {
	// Simple runtime.GOARCH detection doesn't work if the CLI is
	// running under Rosetta:
	// https://github.com/supabase/cli/issues/1266. So as a workaround
	// we use Apple Silicon detection:
	// https://www.yellowduck.be/posts/detecting-apple-silicon-via-go.
	_, err := syscall.Sysctl("sysctl.proc_translated")
	if err != nil {
		if err.Error() == "no such file or directory" {
			// Running on Intel Mac.
			return "deno-x86_64-apple-darwin.zip", nil
		} else {
			return "", errors.Errorf("failed to determine OS triple: %w", err)
		}
	} else {
		// Running on Apple Silicon.
		return "deno-aarch64-apple-darwin.zip", nil
	}
}
