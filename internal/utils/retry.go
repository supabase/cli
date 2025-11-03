package utils

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/go-errors/errors"
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

// RetryWithExponentialBackoff executes fn with exponential backoff retry logic.
// maxRetries is the maximum number of retries (so total attempts = maxRetries + 1).
// onRetry is called before each retry with the retry attempt number (0-indexed) and backoff duration.
// If onRetry is nil, no retry notification is sent.
// Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s for retries 0-5.
func RetryWithExponentialBackoff(ctx context.Context, fn func() error, maxRetries int, onRetry func(attempt int, backoff time.Duration)) error {
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		lastErr = err

		// Don't retry if context is canceled
		if errors.Is(ctx.Err(), context.Canceled) {
			return lastErr
		}

		// Don't retry if we've exhausted all retries
		if attempt >= maxRetries {
			break
		}

		// Calculate exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s
		backoff := time.Duration(1<<uint(attempt)) * time.Second
		if onRetry != nil {
			onRetry(attempt, backoff)
		}
		time.Sleep(backoff)
	}
	return lastErr
}
