//go:build darwin

package login

import (
	"context"
	"os/exec"
)

func RunOpenCmd(ctx context.Context, input string) error {
	cmd := exec.CommandContext(ctx, "open", input)
	return cmd.Run()
}
