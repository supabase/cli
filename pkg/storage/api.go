package storage

import "github.com/supabase/cli/v2/pkg/fetcher"

type StorageAPI struct {
	*fetcher.Fetcher
}

const PAGE_LIMIT = 100
