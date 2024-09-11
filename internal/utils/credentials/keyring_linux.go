//go:build linux

package credentials

import (
	"github.com/go-errors/errors"
	ss "github.com/zalando/go-keyring/secret_service"
)

func deleteAll(service string) error {
	svc, err := ss.NewSecretService()
	if err != nil {
		return errors.Errorf("failed to create secret service: %w", err)
	}

	collection := svc.GetLoginCollection()
	if err := svc.Unlock(collection.Path()); err != nil {
		return errors.Errorf("failed to unlock collection: %w", err)
	}

	search := map[string]string{"service": service}
	results, err := svc.SearchItems(collection, search)
	if err != nil {
		return errors.Errorf("failed to search items: %w", err)
	}

	for _, item := range results {
		if err := svc.Delete(item); err != nil {
			return errors.Errorf("failed to delete all credentials: %w", err)
		}
	}
	return nil
}
