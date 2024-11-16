package config

import (
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
)

type (
	storage struct {
		Enabled             bool                 `toml:"enabled"`
		Image               string               `toml:"-"`
		FileSizeLimit       sizeInBytes          `toml:"file_size_limit"`
		S3Credentials       storageS3Credentials `toml:"-"`
		ImageTransformation imageTransformation  `toml:"image_transformation"`
		Buckets             BucketConfig         `toml:"buckets"`
	}

	imageTransformation struct {
		Enabled bool   `toml:"enabled"`
		Image   string `toml:"-"`
	}

	storageS3Credentials struct {
		AccessKeyId     string `toml:"-"`
		SecretAccessKey string `toml:"-"`
		Region          string `toml:"-"`
	}

	BucketConfig map[string]bucket

	bucket struct {
		Public           *bool       `toml:"public"`
		FileSizeLimit    sizeInBytes `toml:"file_size_limit"`
		AllowedMimeTypes []string    `toml:"allowed_mime_types"`
		ObjectsPath      string      `toml:"objects_path"`
	}
)

func (s *storage) ToUpdateStorageConfigBody() v1API.UpdateStorageConfigBody {
	body := v1API.UpdateStorageConfigBody{Features: &v1API.StorageFeatures{}}
	body.FileSizeLimit = cast.Ptr(int64(s.FileSizeLimit))
	body.Features.ImageTransformation.Enabled = s.ImageTransformation.Enabled
	return body
}

func (s *storage) FromRemoteStorageConfig(remoteConfig v1API.StorageConfigResponse) {
	s.FileSizeLimit = sizeInBytes(remoteConfig.FileSizeLimit)
	s.ImageTransformation.Enabled = remoteConfig.Features.ImageTransformation.Enabled
}

func (s *storage) DiffWithRemote(remoteConfig v1API.StorageConfigResponse) ([]byte, error) {
	copy := *s
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	copy.FromRemoteStorageConfig(remoteConfig)
	remoteCompare, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[storage]", remoteCompare, "local[storage]", currentValue), nil
}
