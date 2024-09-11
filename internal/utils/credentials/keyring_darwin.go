//go:build darwin

package credentials

import (
	"os/exec"

	"github.com/go-errors/errors"
)

const execPathKeychain = "/usr/bin/security"

func deleteAll(service string) error {
	if len(service) == 0 {
		return errors.New("missing service name")
	}
	// Delete each secret in a while loop until there is no more left
	for {
		if err := exec.Command(
			execPathKeychain,
			"delete-generic-password",
			"-s", service,
		).Run(); err == nil {
			continue
		} else if errors.Is(err, exec.ErrNotFound) {
			return errors.New(ErrNotSupported)
		} else if exitError, ok := err.(*exec.ExitError); ok && exitError.ExitCode() == 44 {
			// Exit 44 means no item exists for this service name
			return nil
		} else {
			return errors.Errorf("failed to delete all credentials: %w", err)
		}
	}
}
