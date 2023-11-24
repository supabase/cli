//go:build !windows && !darwin

package login

import (
	"context"
	"os/exec"
)

func RunOpenCmd(ctx context.Context, input string) error {
	cmd := exec.CommandContext(ctx, "xdg-open", input)
	return cmd.Run()
}
