package storage

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/supabase/cli/pkg/fetcher"
)

type AnalyticsBucketResponse struct {
	Id        string `json:"id"`         // "test"
	Name      string `json:"name"`       // "test"
	CreatedAt string `json:"created_at"` // "2023-10-13T17:48:58.491Z"
	UpdatedAt string `json:"updated_at"` // "2023-10-13T17:48:58.491Z"
}

type CreateAnalyticsBucketRequest struct {
	BucketName string `json:"bucketName"`
}

func (s *StorageAPI) UpsertAnalyticsBuckets(ctx context.Context, bucketConfig map[string]struct{}, filter ...func(string) bool) error {
	resp, err := s.Send(ctx, http.MethodGet, "/storage/v1/iceberg/bucket", nil)
	if err != nil {
		return err
	}
	buckets, err := fetcher.ParseJSON[[]AnalyticsBucketResponse](resp.Body)
	if err != nil {
		return err
	}
	var toDelete []string
	exists := make(map[string]struct{}, len(buckets))
	for _, b := range buckets {
		exists[b.Name] = struct{}{}
		if _, ok := bucketConfig[b.Name]; !ok {
			toDelete = append(toDelete, b.Name)
		}
	}
	for name := range bucketConfig {
		if _, ok := exists[name]; ok {
			fmt.Fprintln(os.Stderr, "Bucket already exists:", name)
			continue
		}
		fmt.Fprintln(os.Stderr, "Creating analytics bucket:", name)
		body := CreateAnalyticsBucketRequest{BucketName: name}
		if resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/iceberg/bucket", body); err != nil {
			return err
		} else if err := resp.Body.Close(); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
OUTER:
	for _, name := range toDelete {
		for _, keep := range filter {
			if !keep(name) {
				continue OUTER
			}
		}
		fmt.Fprintln(os.Stderr, "Pruning analytics bucket:", name)
		if resp, err := s.Send(ctx, http.MethodDelete, "/storage/v1/iceberg/bucket/"+name, nil); err != nil {
			return err
		} else if err := resp.Body.Close(); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
	return nil
}
