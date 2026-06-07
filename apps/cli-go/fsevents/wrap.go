//go:build darwin

package fsevents

// CreateFlags specifies what events will be seen in an event stream.
type CreateFlags uint32

const (
	// IgnoreSelf doesn't send events triggered by the current process (macOS 10.6+).
	//
	// Don't send events that were triggered by the current process.
	// This is useful for reducing the volume of events that are
	// sent. It is only useful if your process might modify the file
	// system hierarchy beneath the path(s) being monitored. Note:
	// this has no effect on historical events, i.e., those
	// delivered before the HistoryDone sentinel event.
	IgnoreSelf = CreateFlags(0)

	// FileEvents sends events about individual files, generating significantly
	// more events (macOS 10.7+) than directory level notifications.
	FileEvents = CreateFlags(1)
)

// EventFlags passed to the FSEventStreamCallback function.
// These correspond directly to the flags as described here:
// https://developer.apple.com/documentation/coreservices/1455361-fseventstreameventflags
type EventFlags uint32

const (
	// ItemCreated indicates that a file or directory has been created.
	ItemCreated = EventFlags(0)

	// ItemIsDir indicates that the item is a directory.
	ItemIsDir = EventFlags(1)
)

// LatestEventID returns the most recently generated event ID, system-wide.
func LatestEventID() uint64 {
	return 0
}
