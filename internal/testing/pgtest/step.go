package pgtest

import (
	"fmt"
	"reflect"

	"github.com/jackc/pgmock"
	"github.com/jackc/pgproto3/v2"
	"github.com/jackc/pgtype"
)

type extendedQueryStep struct {
	sql    string
	params [][]byte
	oids   []uint32
	reply  pgmock.Script
}

func (e *extendedQueryStep) Step(backend *pgproto3.Backend) error {
	msg, err := getFrontendMessage(backend)
	if err != nil {
		return err
	}

	// Handle prepared statements, name can be dynamic: lrupsc_5_0
	if m, ok := msg.(*pgproto3.Parse); ok {
		want := &pgproto3.Parse{Name: m.Name, Query: e.sql, ParameterOIDs: m.ParameterOIDs}
		if !reflect.DeepEqual(m, want) {
			return fmt.Errorf("msg => %#v, e.want => %#v", m, want)
		}
		// Anonymous ps falls through
		if m.Name != "" {
			script := pgmock.Script{Steps: []pgmock.Step{
				pgmock.ExpectMessage(&pgproto3.Describe{ObjectType: 'S', Name: m.Name}),
				pgmock.ExpectMessage(&pgproto3.Sync{}),
				pgmock.SendMessage(&pgproto3.ParseComplete{}),
				pgmock.SendMessage(&pgproto3.ParameterDescription{ParameterOIDs: e.oids}),
				// Postgres responds pgproto3.RowDescription but it's optional for pgx
				pgmock.SendMessage(&pgproto3.ReadyForQuery{TxStatus: 'I'}),
			}}
			if err := script.Run(backend); err != nil {
				return err
			}
		}
		// Expect bind command next
		msg, err = backend.Receive()
		if err != nil {
			return err
		}
	}

	if m, ok := msg.(*pgproto3.Bind); ok {
		var codes []int16
		for range e.oids {
			codes = append(codes, pgtype.TextFormatCode)
		}
		want := &pgproto3.Bind{
			ParameterFormatCodes: codes,
			Parameters:           e.params,
			ResultFormatCodes:    []int16{},
			DestinationPortal:    m.DestinationPortal,
			PreparedStatement:    m.PreparedStatement,
		}
		if !reflect.DeepEqual(m, want) {
			return fmt.Errorf("msg => %#v, e.want => %#v", msg, want)
		}
		e.reply.Steps = append([]pgmock.Step{
			pgmock.ExpectMessage(&pgproto3.Describe{ObjectType: 'P'}),
			pgmock.ExpectMessage(&pgproto3.Execute{}),
			pgmock.SendMessage(&pgproto3.ParseComplete{}),
			pgmock.SendMessage(&pgproto3.BindComplete{}),
		}, e.reply.Steps...)
		return e.reply.Run(backend)
	}

	// Handle simple query
	want := &pgproto3.Query{String: e.sql}
	if m, ok := msg.(*pgproto3.Query); ok && reflect.DeepEqual(m, want) {
		e.reply.Steps = append(e.reply.Steps, pgmock.SendMessage(&pgproto3.ReadyForQuery{TxStatus: 'I'}))
		return e.reply.Run(backend)
	}

	return fmt.Errorf("msg => %#v, e.want => %#v", msg, want)
}

// Expects a SQL query in any form: simple, prepared, or anonymous.
func ExpectQuery(sql string, params [][]byte, oids []uint32) pgmock.Step {
	return &extendedQueryStep{sql: sql, params: params, oids: oids}
}

type terminateStep struct{}

func (e *terminateStep) Step(backend *pgproto3.Backend) error {
	msg, err := getFrontendMessage(backend)
	if err != nil {
		return err
	}

	// Handle simple query
	if _, ok := msg.(*pgproto3.Terminate); ok {
		return nil
	}

	return fmt.Errorf("msg => %#v, e.want => %#v", msg, &pgproto3.Terminate{})
}

func ExpectTerminate() pgmock.Step {
	return &terminateStep{}
}

func getFrontendMessage(backend *pgproto3.Backend) (pgproto3.FrontendMessage, error) {
	msg, err := backend.Receive()
	if err != nil {
		return nil, err
	}

	// Sync signals end of batch statements
	if _, ok := msg.(*pgproto3.Sync); ok {
		reply := pgmock.SendMessage(&pgproto3.ReadyForQuery{TxStatus: 'I'})
		if err := reply.Step(backend); err != nil {
			return nil, err
		}
		msg, err = backend.Receive()
		if err != nil {
			return nil, err
		}
	}

	return msg, nil
}
