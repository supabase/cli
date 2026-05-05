package storage

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/supabase/cli/pkg/fetcher"
)

type VectorBucket struct {
	VectorBucketName string `json:"vectorBucketName"`
	CreationTime     uint64 `json:"creationTime"`
}

type ListVectorBucketsResponse struct {
	VectorBuckets []VectorBucket `json:"vectorBuckets"`
}

type ListVectorBucketsRequest struct {
	MaxResults uint64 `json:"maxResults,omitempty"`
	NextToken  string `json:"nextToken,omitempty"`
	Prefix     string `json:"prefix,omitempty"`
}

type CreateVectorBucketRequest struct {
	VectorBucketName string `json:"vectorBucketName"`
}

type DeleteVectorBucketRequest struct {
	VectorBucketName string `json:"vectorBucketName"`
}

func (s *StorageAPI) UpsertVectorBuckets(ctx context.Context, bucketConfig map[string]struct{}, filter ...func(string) bool) error {
	resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/vector/ListVectorBuckets", ListVectorBucketsRequest{})
	if err != nil {
		return err
	}
	result, err := fetcher.ParseJSON[ListVectorBucketsResponse](resp.Body)
	if err != nil {
		return err
	}
	var toDelete []string
	exists := make(map[string]struct{}, len(result.VectorBuckets))
	for _, b := range result.VectorBuckets {
		exists[b.VectorBucketName] = struct{}{}
		if _, ok := bucketConfig[b.VectorBucketName]; !ok {
			toDelete = append(toDelete, b.VectorBucketName)
		}
	}
	for name := range bucketConfig {
		if _, ok := exists[name]; ok {
			fmt.Fprintln(os.Stderr, "Bucket already exists:", name)
			continue
		}
		fmt.Fprintln(os.Stderr, "Creating vector bucket:", name)
		body := CreateVectorBucketRequest{VectorBucketName: name}
		if resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/vector/CreateVectorBucket", body); err != nil {
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
		fmt.Fprintln(os.Stderr, "Pruning vector bucket:", name)
		body := DeleteVectorBucketRequest{VectorBucketName: name}
		if resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/vector/DeleteVectorBucket", body); err != nil {
			return err
		} else if err := resp.Body.Close(); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
	return nil
}
