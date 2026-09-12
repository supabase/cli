package parser

import (
	"bytes"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	// Omit BEGIN to allow arbitrary whitespaces between BEGIN and ATOMIC keywords.
	// This can fail if ATOMIC is used as column name because it is not a reserved
	// keyword: https://www.postgresql.org/docs/current/sql-keywords-appendix.html
	BEGIN_ATOMIC = "ATOMIC"
	END_ATOMIC   = "END"
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
		// A $ after an identifier rune continues the identifier (pending$$foo$), not a
		// dollar quote. A digit counts too (1$$), unlike PostgreSQL; valid SQL never has that.
		offset := len(data) - utf8.RuneLen(r)
		if hasIdentifierRuneBefore(data, offset) {
			return s
		}
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
	case '(':
		return &ParenState{prev: s}
	case 'c':
		fallthrough
	case 'C':
		if isBeginAtomic(data) {
			return &AtomicState{prev: s, statementStart: len(data)}
		}
	}
	return s
}

func isBeginAtomic(data []byte) bool {
	if !endsWithKeyword(data, BEGIN_ATOMIC) {
		return false
	}
	prefix := bytes.TrimRight(data[:len(data)-len(BEGIN_ATOMIC)], sqlWhitespace)
	return endsWithKeyword(prefix, "BEGIN")
}

// PostgreSQL's scan.l treats every byte at or above 0x80 as an identifier/dollar-tag
// character (ident_cont/dolq_cont), whatever its Unicode category.
func isIdentifierRune(r rune) bool {
	return r >= utf8.RuneSelf || unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '$'
}

func hasIdentifierRuneBefore(data []byte, offset int) bool {
	if offset <= 0 {
		return false
	}
	r, _ := utf8.DecodeLastRune(data[:offset])
	return isIdentifierRune(r)
}

func endsWithKeyword(data []byte, keyword string) bool {
	offset := len(data) - len(keyword)
	if offset < 0 || !strings.EqualFold(string(data[offset:]), keyword) {
		return false
	}
	return !hasIdentifierRuneBefore(data, offset)
}

const sqlWhitespace = " \t\n\r\f\v"

func isSqlWhitespace(b byte) bool {
	return bytes.IndexByte([]byte(sqlWhitespace), b) >= 0
}

func isCommentsAndWhitespace(text []byte) bool {
	for i := 0; i < len(text); {
		switch {
		case isSqlWhitespace(text[i]):
			i++
		case bytes.HasPrefix(text[i:], []byte("--")):
			newline := bytes.IndexByte(text[i+2:], '\n')
			if newline == -1 {
				return true
			}
			i += 2 + newline + 1
		case bytes.HasPrefix(text[i:], []byte("/*")):
			// Match BlockState's sliding-window scan so both agree on overlapping delimiters.
			depth := 1
			i += 2
			for i < len(text) && depth > 0 {
				switch {
				case bytes.HasPrefix(text[i-1:], []byte("/*")):
					depth++
				case bytes.HasPrefix(text[i-1:], []byte("*/")):
					depth--
				}
				i++
			}
			if depth > 0 {
				return true
			}
		default:
			return false
		}
	}
	return true
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
		// Break out of dollar state
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
	if isIdentifierRune(r) {
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

// Opened a parenthesis group
type ParenState struct {
	prev State
}

func (s *ParenState) Next(r rune, data []byte) State {
	curr := s.prev.Next(r, data)
	if curr == nil {
		s.prev = &ReadyState{}
		return s
	}
	s.prev = curr
	if _, ok := s.prev.(*ReadyState); !ok {
		return s
	}
	if r == ')' {
		return &ReadyState{}
	}
	return s
}

// Opened BEGIN ATOMIC function body
type AtomicState struct {
	prev                State
	pendingEnd          bool
	statementStart      int
	statementHasContent bool
}

func (s *AtomicState) Next(r rune, data []byte) State {
	pendingEnd := s.pendingEnd
	s.pendingEnd = false
	if pendingEnd && !isIdentifierRune(r) {
		return (&ReadyState{}).Next(r, data)
	}
	// An END inside a nested quote/comment doesn't count.
	curr := s.prev.Next(r, data)
	if curr == nil {
		s.prev = &ReadyState{}
		s.statementStart = len(data)
		s.statementHasContent = false
		return s
	}
	s.prev = curr
	if _, ok := s.prev.(*ReadyState); !ok {
		return s
	}
	// PostgreSQL requires each inner statement to end with ';', so the closing END is
	// always the first token of a statement; a later END is expression text.
	if !s.statementHasContent && endsWithKeyword(data, END_ATOMIC) {
		if isCommentsAndWhitespace(data[s.statementStart : len(data)-len(END_ATOMIC)]) {
			s.pendingEnd = true
		} else {
			s.statementHasContent = true
		}
	}
	return s
}
