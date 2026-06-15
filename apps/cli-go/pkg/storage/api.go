package storage

import "github.com/supabase/cli/apps/cli-go/pkg/fetcher"

type StorageAPI struct {
	*fetcher.Fetcher
}

const PAGE_LIMIT = 100
