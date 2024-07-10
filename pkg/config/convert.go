package config

import (
	types "github.com/supabase/cli/pkg/storage"
)

func (s *storage) GetBucketConfig() map[string]types.BucketProps {
	result := make(map[string]types.BucketProps, len(s.Buckets))
	for name, bucket := range s.Buckets {
		props := types.BucketProps{
			Public:           bucket.Public,
			AllowedMimeTypes: bucket.AllowedMimeTypes,
		}
		if bucket.FileSizeLimit > 0 {
			props.FileSizeLimit = int(bucket.FileSizeLimit)
		} else {
			props.FileSizeLimit = int(s.FileSizeLimit)
		}
		result[name] = props
	}
	return result
}
