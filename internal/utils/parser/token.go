package parser

import (
	"bufio"
	"io"
	"unicode/utf8"

	"github.com/spf13/viper"
)

const (
	// Default max capacity is 64 * 1024 which is not enough for certain lines
	// containing e.g. geographical data.
	// 256K ought to be enough for anybody...
	MaxScannerCapacity = 256 * 1024
	// Equal to `startBufSize` from `bufio/scan.go`
	startBufSize = 4096
)

// State transition table for tokenizer:
//
//	Ready -> Ready (default)
//	Ready -> Error (on invalid syntax)
//	Ready -> Done (on ;, emit token)
//	Ready -> Done (on EOF, emit token)
//
//	Ready -> Comment (on --)
//	Comment -> Comment (default)
//	Comment -> Ready (on \n)
//
//	Ready -> Block (on /*)
//	Block -> Block (on /*, +-depth)
//	Block -> Ready (on */, depth 0)
//
//	Ready -> Quote (on ')
//	Quote -> Quote (on '', default)
//	Quote -> Ready (on ')
//
//	Ready -> Dollar (on $tag$)
//	Dollar -> Dollar (default)
//	Dollar -> Ready (on $tag$)
//
//	Ready -> Escape (on \)
//	Escape -> Ready (on next)
type tokenizer struct {
	state State
	last  int
}

func (t *tokenizer) ScanToken(data []byte, atEOF bool) (advance int, token []byte, err error) {
	// If we requested more data, resume from last position.
	for width := 1; t.last < len(data); t.last += width {
		r, width := utf8.DecodeRune(data[t.last:])
		end := t.last + width
		t.state = t.state.Next(r, data[:end])
		// Emit token
		if t.state == nil {
			t.last = 0
			t.state = &ReadyState{}
			return end, data[:end], nil
		}
	}
	if !atEOF || len(data) == 0 {
		// Request more data or end the stream
		return 0, nil, nil
	}
	// We're at EOF. If we have a final, non-terminated token, return it.
	return len(data), data, nil
}

// Use bufio.Scanner to split a PostgreSQL string into multiple statements.
//
// The core problem is to figure out whether the current ; separator is inside
// an escaped string literal. PostgreSQL has multiple ways of opening a string
// literal, $$, ', --, /*, etc. We use a FSM to guarantee these states are
// entered exclusively. If not in one of the above escape states, the next ;
// token can be parsed as statement separator.
//
// Each statement is split as it is, without removing comments or white spaces.
func Split(sql io.Reader) (stats []string, err error) {
	t := tokenizer{state: &ReadyState{}}
	scanner := bufio.NewScanner(sql)

	// Increase scanner capacity to support very long lines containing e.g. geodata
	buf := make([]byte, startBufSize)
	maxbuf := viper.GetSizeInBytes("SCANNER_BUFFER_SIZE")
	if maxbuf == 0 {
		maxbuf = MaxScannerCapacity
	}
	scanner.Buffer(buf, int(maxbuf))

	scanner.Split(t.ScanToken)
	for scanner.Scan() {
		token := scanner.Text()
		stats = append(stats, token)
	}
	return stats, scanner.Err()
}
