package queue

import (
	"sync"

	"github.com/go-errors/errors"
)

// JobQueue implements a background job processor using a single channel and wait group.
//
// The channel is initialised with a maximum number of concurrent workers. Adding a new job
// consumes a worker from the channel. After finishing a job, the worker is added back to
// the channel. When all workers are consumed, adding new job will block.
//
// Example usage:
//
//	jq := NewJobQueue(5)
//	err := jq.Put(func() error {
//		return nil
//	})
//	errors.Join(err, jq.Collect())
type JobQueue struct {
	wg    sync.WaitGroup
	errCh chan error
}

func NewJobQueue(maxConcurrency uint) *JobQueue {
	q := &JobQueue{
		errCh: make(chan error, maxConcurrency),
	}
	for i := 0; i < cap(q.errCh); i++ {
		q.errCh <- nil
	}
	return q
}

// Put runs a job in the background, returning any error from the previous job.
func (q *JobQueue) Put(job func() error) error {
	err := <-q.errCh
	q.wg.Add(1)
	go func() {
		defer q.wg.Done()
		q.errCh <- job()
	}()
	return err
}

// Collect waits for all jobs to finish, returning any errors.
func (q *JobQueue) Collect() error {
	q.wg.Wait()
	var err []error
	for i := 0; i < cap(q.errCh); i++ {
		err = append(err, <-q.errCh)
		q.errCh <- nil
	}
	return errors.Join(err...)
}
