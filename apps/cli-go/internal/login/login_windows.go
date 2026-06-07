//go:build windows

package login

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
)

func RunOpenCmd(ctx context.Context, input string) error {
	cmd := exec.CommandContext(ctx, filepath.Join(os.Getenv("SYSTEMROOT"), "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", input)
	return cmd.Run()
}
