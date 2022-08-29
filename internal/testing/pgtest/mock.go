package pgtest

import (
	"context"
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

var ci = pgtype.NewConnInfo()

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
	steps = append(
		steps,
		pgmock.ExpectMessage(&pgproto3.StartupMessage{
			ProtocolVersion: pgproto3.ProtocolVersionNumber,
			Parameters:      map[string]string{"database": config.Database, "user": config.User},
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
	config.TLSConfig = nil
	// Add startup message
	r.script.Steps = append(r.getStartupMessage(config), r.script.Steps...)
}

// Adds a simple query or prepared statement to the mock connection.
func (r *MockConn) Query(sql string, args ...interface{}) *MockConn {
	var oids []uint32
	var params [][]byte
	for _, v := range args {
		if dt, ok := ci.DataTypeForValue(v); ok {
			if err := dt.Value.Set(v); err != nil {
				continue
			}
			value, err := (dt.Value).(pgtype.TextEncoder).EncodeText(ci, []byte{})
			if err != nil {
				continue
			}
			params = append(params, value)
			oids = append(oids, dt.OID)
		}
	}
	r.script.Steps = append(r.script.Steps, ExpectQuery(sql, params, oids))
	return r
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

// Adds a server reply using text protocol format.
//
// TODO: support binary protocol
func (r *MockConn) Reply(tag string, rows ...map[string]interface{}) *MockConn {
	q := r.lastQuery()
	// Add field description
	if len(rows) > 0 {
		var desc pgproto3.RowDescription
		for k, v := range rows[0] {
			if dt, ok := ci.DataTypeForValue(v); ok {
				size := getDataTypeSize(v)
				desc.Fields = append(desc.Fields, pgproto3.FieldDescription{
					Name:                 []byte(k),
					TableOID:             17131,
					TableAttributeNumber: 1,
					DataTypeOID:          dt.OID,
					DataTypeSize:         size,
					TypeModifier:         -1,
					Format:               pgtype.TextFormatCode,
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
			if dt, ok := ci.DataTypeForValue(v); ok {
				if err := dt.Value.Set(v); err != nil {
					continue
				}
				if value, err := (dt.Value).(pgtype.TextEncoder).EncodeText(ci, []byte{}); err == nil {
					dr.Values = append(dr.Values, value)
				}
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
		t.Fatalf("failed to close %v", err)
	}
	if err := r.server.Close(); err != nil {
		t.Fatalf("failed to close %v", err)
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
