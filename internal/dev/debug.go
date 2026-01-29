package dev

import "github.com/supabase/cli/internal/utils"

// Namespaced debug loggers for the dev package
// Enable via DEBUG environment variable:
//
//	DEBUG=supabase:dev:*        - all dev logs
//	DEBUG=supabase:dev:timing   - only timing logs
//	DEBUG=supabase:dev:watcher  - only watcher logs
//	DEBUG=supabase:dev:sql      - SQL statements being executed
var (
	timingLog  = utils.NewDebugLogger("supabase:dev:timing")
	watcherLog = utils.NewDebugLogger("supabase:dev:watcher")
	sqlLog     = utils.NewDebugLogger("supabase:dev:sql")
)
