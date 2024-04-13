package pgtest

import (
	"context"
	"fmt"
	"net"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgmock"
	"github.com/jackc/pgproto3/v2"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v4"
	"google.golang.org/grpc/test/bufconn"
)

type MockConn struct {
	// Duplex server listener backed by in-memory buffer
	server *bufconn.Listener

	// Mock server requests and responses
	script pgmock.Script

	// Status parameters emitted by postgres on first connect
	status map[string]string

	// Channel for reporting all server error
	errChan chan error
}

func (r *MockConn) getStartupMessage(config *pgx.ConnConfig) []pgmock.Step {
	var steps []pgmock.Step
	// Add auth message
	params := map[string]string{"user": config.User}
	if len(config.Database) > 0 {
		params["database"] = config.Database
	}
	steps = append(
		steps,
		pgmock.ExpectMessage(&pgproto3.StartupMessage{
			ProtocolVersion: pgproto3.ProtocolVersionNumber,
			Parameters:      params,
		}),
		pgmock.SendMessage(&pgproto3.AuthenticationOk{}),
	)
	// Add status message
	r.status["session_authorization"] = config.User
	for key, value := range r.status {
		steps = append(steps, pgmock.SendMessage(&pgproto3.ParameterStatus{Name: key, Value: value}))
	}
	// Add ready message
	steps = append(
		steps,
		pgmock.SendMessage(&pgproto3.BackendKeyData{ProcessID: 0, SecretKey: 0}),
		pgmock.SendMessage(&pgproto3.ReadyForQuery{TxStatus: 'I'}),
	)
	return steps
}

// Configures pgx to use the mock dialer.
//
// The mock dialer provides a full duplex net.Conn backed by an in-memory buffer.
// It is implemented by grcp/test/bufconn package.
func (r *MockConn) Intercept(config *pgx.ConnConfig) {
	// Override config for test
	config.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return r.server.DialContext(ctx)
	}
	config.LookupFunc = func(ctx context.Context, host string) (addrs []string, err error) {
		return []string{"127.0.0.1"}, nil
	}
	config.TLSConfig = nil
	// Add startup message
	r.script.Steps = append(r.getStartupMessage(config), r.script.Steps...)
}

// Adds a simple query or prepared statement to the mock connection.
func (r *MockConn) Query(sql string, args ...interface{}) *MockConn {
	var oids []uint32
	var params [][]byte
	for _, v := range args {
		if value, oid := r.encodeValueArg(v); oid > 0 {
			params = append(params, value)
			oids = append(oids, oid)
		}
	}
	r.script.Steps = append(r.script.Steps, ExpectQuery(sql, params, oids))
	return r
}

func (r *MockConn) encodeValueArg(v interface{}) (value []byte, oid uint32) {
	if v == nil {
		return nil, pgtype.TextArrayOID
	}
	dt, ok := ci.DataTypeForValue(v)
	if !ok {
		r.errChan <- fmt.Errorf("no suitable type for arg: %v", v)
		return nil, 0
	}
	if err := dt.Value.Set(v); err != nil {
		r.errChan <- fmt.Errorf("failed to set value: %w", err)
		return nil, 0
	}
	var err error
	switch dt.OID {
	case pgtype.TextArrayOID:
		value, err = (dt.Value).(pgtype.BinaryEncoder).EncodeBinary(ci, []byte{})
	default:
		value, err = (dt.Value).(pgtype.TextEncoder).EncodeText(ci, []byte{})
	}
	if err != nil {
		r.errChan <- fmt.Errorf("failed to encode arg: %w", err)
		return nil, 0
	}
	return value, dt.OID
}

func getDataTypeSize(v interface{}) int16 {
	t := reflect.TypeOf(v)
	k := t.Kind()
	if k < reflect.Int || k > reflect.Complex128 {
		return -1
	}
	return int16(t.Size())
}

func (r *MockConn) lastQuery() *extendedQueryStep {
	return r.script.Steps[len(r.script.Steps)-1].(*extendedQueryStep)
}

// Adds a server reply using binary or text protocol format.
//
// TODO: support prepared statements when using binary protocol
func (r *MockConn) Reply(tag string, rows ...[]interface{}) *MockConn {
	q := r.lastQuery()
	// Add field description
	if len(rows) > 0 {
		var desc pgproto3.RowDescription
		for i, v := range rows[0] {
			name := fmt.Sprintf("c_%02d", i)
			if dt, ok := ci.DataTypeForValue(v); ok {
				size := getDataTypeSize(v)
				format := ci.ParamFormatCodeForOID(dt.OID)
				desc.Fields = append(desc.Fields, pgproto3.FieldDescription{
					Name:                 []byte(name),
					TableOID:             17131,
					TableAttributeNumber: 1,
					DataTypeOID:          dt.OID,
					DataTypeSize:         size,
					TypeModifier:         -1,
					Format:               format,
				})
			}
		}
		q.reply.Steps = append(q.reply.Steps, pgmock.SendMessage(&desc))
	} else {
		// No data is optional, but we add for completeness
		q.reply.Steps = append(q.reply.Steps, pgmock.SendMessage(&pgproto3.NoData{}))
	}
	// Add row data
	for _, data := range rows {
		var dr pgproto3.DataRow
		for _, v := range data {
			if value, oid := r.encodeValueArg(v); oid > 0 {
				dr.Values = append(dr.Values, value)
			}
		}
		q.reply.Steps = append(q.reply.Steps, pgmock.SendMessage(&dr))
	}
	// Add completion message
	var complete pgproto3.BackendMessage
	if tag == "" {
		complete = &pgproto3.EmptyQueryResponse{}
	} else {
		complete = &pgproto3.CommandComplete{CommandTag: []byte(tag)}
	}
	q.reply.Steps = append(q.reply.Steps, pgmock.SendMessage(complete))
	return r
}

// Simulates an error reply from the server.
//
// TODO: simulate a notice reply
func (r *MockConn) ReplyError(code, message string) *MockConn {
	q := r.lastQuery()
	q.reply.Steps = append(
		q.reply.Steps,
		pgmock.SendMessage(&pgproto3.ErrorResponse{
			Severity:            "ERROR",
			SeverityUnlocalized: "ERROR",
			Code:                code,
			Message:             message,
		}),
	)
	return r
}

func (r *MockConn) Close(t *testing.T) {
	if err := <-r.errChan; err != nil {
		t.Fatalf("failed to close: %v", err)
	}
	if err := r.server.Close(); err != nil {
		t.Fatalf("failed to close: %v", err)
	}
}

func NewWithStatus(status map[string]string) *MockConn {
	const bufSize = 1024 * 1024
	mock := MockConn{
		server:  bufconn.Listen(bufSize),
		status:  status,
		errChan: make(chan error, 1),
	}
	// Start server in background
	const timeout = time.Millisecond * 450
	go func() {
		defer close(mock.errChan)
		// Block until we've opened a TCP connection
		conn, err := mock.server.Accept()
		if err != nil {
			mock.errChan <- err
			return
		}
		defer conn.Close()
		// Prevent server from hanging the test
		err = conn.SetDeadline(time.Now().Add(timeout))
		if err != nil {
			mock.errChan <- err
			return
		}
		// Always expect clients to terminate the request
		mock.script.Steps = append(mock.script.Steps, ExpectTerminate())
		err = mock.script.Run(pgproto3.NewBackend(pgproto3.NewChunkReader(conn), conn))
		if err != nil {
			mock.errChan <- err
			return
		}
	}()

	return &mock
}

func NewConn() *MockConn {
	return NewWithStatus(map[string]string{
		"application_name":              "",
		"client_encoding":               "UTF8",
		"DateStyle":                     "ISO, MDY",
		"default_transaction_read_only": "off",
		"in_hot_standby":                "off",
		"integer_datetimes":             "on",
		"IntervalStyle":                 "postgres",
		"is_superuser":                  "on",
		"server_encoding":               "UTF8",
		"server_version":                "14.3 (Debian 14.3-1.pgdg110+1)",
		"standard_conforming_strings":   "on",
		"TimeZone":                      "UTC",
	})
}
