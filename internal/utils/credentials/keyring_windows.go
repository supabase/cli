//go:build windows

package credentials

import (
	"github.com/danieljoos/wincred"
	"github.com/go-errors/errors"
)

func deleteAll(service string) error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	creds, err := wincred.FilteredList(service + ":")
	if err != nil {
		return errors.Errorf("failed to list credentials: %w", err)
	}
	for _, c := range creds {
		gc := wincred.GenericCredential{Credential: *c}
		if err := gc.Delete(); err != nil {
			return errors.Errorf("failed to delete all credentials: %w", err)
		}
	}
	return nil
}
