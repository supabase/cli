// Backported from pgx/v5: https://github.com/jackc/pgx/blob/v5.3.1/rows.go#L408
package pgxv5

import (
	"reflect"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgproto3/v2"
	"github.com/jackc/pgx/v4"
)

// CollectRows iterates through rows, calling fn for each row, and collecting the results into a slice of T.
func CollectRows[T any](rows pgx.Rows) ([]T, error) {
	defer rows.Close()

	slice := []T{}

	for rows.Next() {
		var value T
		if err := ScanRowToStruct(rows, &value); err != nil {
			return nil, err
		}
		slice = append(slice, value)
	}

	if err := rows.Err(); err != nil {
		return nil, errors.Errorf("failed to collect rows: %w", err)
	}

	return slice, nil
}

func ScanRowToStruct(rows pgx.Rows, dst any) error {
	dstValue := reflect.ValueOf(dst)
	if dstValue.Kind() != reflect.Ptr {
		return errors.Errorf("dst not a pointer")
	}

	dstElemValue := dstValue.Elem()
	scanTargets, err := appendScanTargets(dstElemValue, nil, rows.FieldDescriptions())
	if err != nil {
		return err
	}

	for i, t := range scanTargets {
		if t == nil {
			return errors.Errorf("struct doesn't have corresponding row field %s", rows.FieldDescriptions()[i].Name)
		}
	}

	if err := rows.Scan(scanTargets...); err != nil {
		return errors.Errorf("failed to scan targets: %w", err)
	}
	return nil
}

const structTagKey = "db"

func fieldPosByName(fldDescs []pgproto3.FieldDescription, field string) (i int) {
	i = -1
	for i, desc := range fldDescs {
		if strings.EqualFold(string(desc.Name), field) {
			return i
		}
	}
	return
}

func appendScanTargets(dstElemValue reflect.Value, scanTargets []any, fldDescs []pgproto3.FieldDescription) ([]any, error) {
	var err error
	dstElemType := dstElemValue.Type()

	if scanTargets == nil {
		scanTargets = make([]any, len(fldDescs))
	}

	for i := 0; i < dstElemType.NumField(); i++ {
		sf := dstElemType.Field(i)
		if sf.PkgPath != "" && !sf.Anonymous {
			// Field is unexported, skip it.
			continue
		}
		// Handle anoymous struct embedding, but do not try to handle embedded pointers.
		if sf.Anonymous && sf.Type.Kind() == reflect.Struct {
			scanTargets, err = appendScanTargets(dstElemValue.Field(i), scanTargets, fldDescs)
			if err != nil {
				return nil, err
			}
		} else {
			dbTag, dbTagPresent := sf.Tag.Lookup(structTagKey)
			if dbTagPresent {
				dbTag = strings.Split(dbTag, ",")[0]
			}
			if dbTag == "-" {
				// Field is ignored, skip it.
				continue
			}
			colName := dbTag
			if !dbTagPresent {
				colName = sf.Name
			}
			fpos := fieldPosByName(fldDescs, colName)
			if fpos == -1 || fpos >= len(scanTargets) {
				return nil, errors.Errorf("cannot find field %s in returned row", colName)
			}
			scanTargets[fpos] = dstElemValue.Field(i).Addr().Interface()
		}
	}

	return scanTargets, err
}
