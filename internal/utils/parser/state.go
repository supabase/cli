package parser

import (
	"bytes"
	"unicode"
	"unicode/utf8"
)

type State interface {
	// Return nil to emit token
	Next(r rune, data []byte) State
}

// Initial state: ready to parse next token
type ReadyState struct{}

func (s *ReadyState) Next(r rune, data []byte) State {
	switch r {
	case '$':
		offset := len(data) - utf8.RuneLen(r)
		return &TagState{offset: offset}
	case '\'':
		fallthrough
	case '"':
		return &QuoteState{delimiter: r}
	case '-':
		return &CommentState{}
	case '/':
		return &BlockState{}
	case '\\':
		return &EscapeState{}
	case ';':
		// Emit token
		return nil
	}
	return s
}

// Opened a line comment
type CommentState struct{}

func (s *CommentState) Next(r rune, data []byte) State {
	if r == '-' {
		// No characters are escaped in comments, which is the same as dollar
		return &DollarState{delimiter: []byte{'\n'}}
	}
	// Break out of comment state
	state := &ReadyState{}
	return state.Next(r, data)
}

// Opened a block comment
type BlockState struct {
	depth int
}

func (s *BlockState) Next(r rune, data []byte) State {
	const open = "/*"
	const close = "*/"
	window := data[len(data)-2:]
	if bytes.Equal(window, []byte(open)) {
		s.depth += 1
		return s
	}
	if s.depth == 0 {
		// Break out of block state
		state := &ReadyState{}
		return state.Next(r, data)
	}
	if bytes.Equal(window, []byte(close)) {
		s.depth -= 1
		if s.depth == 0 {
			return &ReadyState{}
		}
	}
	return s
}

// Opened a single quote ' or double quote "
type QuoteState struct {
	delimiter rune
	escape    bool
}

func (s *QuoteState) Next(r rune, data []byte) State {
	if s.escape {
		// Preserve escaped quote ''
		if r == s.delimiter {
			s.escape = false
			return s
		}
		// Break out of quote state
		state := &ReadyState{}
		return state.Next(r, data)
	}
	if r == s.delimiter {
		s.escape = true
	}
	return s
}

// Opened a dollar quote, no characters are ever esacped.
type DollarState struct {
	delimiter []byte
}

func (s *DollarState) Next(r rune, data []byte) State {
	window := data[len(data)-len(s.delimiter):]
	if bytes.Equal(window, s.delimiter) {
		// Break out of block state
		return &ReadyState{}
	}
	return s
}

// Opened a tag, ie. $tag$
type TagState struct {
	offset int
}

func (s *TagState) Next(r rune, data []byte) State {
	if r == '$' {
		// Make a copy since the data slice may be overwritten
		tag := data[s.offset:]
		dollar := DollarState{
			delimiter: make([]byte, len(tag)),
		}
		copy(dollar.delimiter, tag)
		return &dollar
	}
	// Valid tag: https://www.postgresql.org/docs/current/sql-syntax-lexical.html
	if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' {
		return s
	}
	// Break out of tag state
	state := &ReadyState{}
	return state.Next(r, data)
}

// Opened a \ escape
type EscapeState struct{}

func (s *EscapeState) Next(r rune, data []byte) State {
	return &ReadyState{}
}
