package utils

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/cenkalti/backoff/v4"
)

const maxRetries = 8

func NewBackoffPolicy(ctx context.Context) backoff.BackOffContext {
	b := backoff.NewExponentialBackOff(backoff.WithInitialInterval(3 * time.Second))
	return backoff.WithContext(backoff.WithMaxRetries(b, maxRetries), ctx)
}

func NewErrorCallback(callbacks ...func(attempt uint) error) backoff.Notify {
	failureCount := uint(0)
	logger := GetDebugLogger()
	return func(err error, d time.Duration) {
		failureCount += 1
		if failureCount*3 > maxRetries {
			logger = os.Stderr
		}
		for _, cb := range callbacks {
			if err := cb(failureCount); err != nil {
				fmt.Fprintln(logger, err)
			}
		}
		fmt.Fprintln(logger, err)
		fmt.Fprintf(logger, "Retry (%d/%d): ", failureCount, maxRetries)
	}
}
