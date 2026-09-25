#!/usr/bin/env python3
"""Summarize matched startup traces without adding overlapping service spans."""
import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path


def spans(events):
    return [{**event, 'seconds': round(event['duration_ms']/1000, 3), **{key: event.get('attributes', {}).get(key) for key in ('member_id', 'service', 'operation')}} for event in events]


def named_span(events, name):
    return next((event for event in events if event['event'] == name), None)


def span_duration(events, name):
    event = named_span(events, name)
    return round(event['duration_ms']/1000, 3) if event else 0


def parse_output(command):
    for line in reversed(command.get('stdout', '').splitlines()):
        try:
            value = json.loads(line)
            if isinstance(value, dict) and 'timings' in value:
                return value
        except ValueError:
            pass
    return {}


def analyze(lifecycle, implementation, phase):
    command = lifecycle[phase]
    events = lifecycle.get('trace', {}).get('events', [])
    begin, end = command['started_epoch_ms'], command['finished_epoch_ms']
    selected = [e for e in events if begin <= e['epoch_ms'] <= end]
    parts = {}
    if implementation == 'cli':
        handler = named_span(selected, 'experimental.stack.start')
        database_start = named_span(selected, 'experimental.stack.databaseStart')
        if handler is not None and database_start is not None:
            parts['cli_entry'] = round((handler['epoch_ms']-begin)/1000, 3)
            parts['stack_setup'] = round((database_start['epoch_ms']-handler['epoch_ms'])/1000, 3)
        parts['database'] = sum(span_duration(selected, name) for name in ('experimental.stack.databaseStart','experimental.stack.databaseReady'))
        parts['catalog'] = span_duration(selected, 'experimental.stack.catalogMigrations')
        parts['project_sql'] = span_duration(selected, 'experimental.stack.projectMigrations')
        parts['composition'] = span_duration(selected, 'experimental.stack.compositionStart')
        parts['other'] = round(command['elapsed_ms']/1000-sum(parts.values()), 3)
    else:
        parts = {key.removesuffix('_ms'): round(value/1000, 3) for key, value in parse_output(command).get('timings', {}).items()}
        parts['entry_and_exit'] = round(command['elapsed_ms']/1000-sum(parts.values()), 3)
    mapped = {}
    for event in events:
        attributes = event.get('attributes', {})
        for member in attributes.get('composition.members', []):
            mapped[member['id']] = member['service']
        if attributes.get('service') and attributes.get('member_id'):
            mapped[attributes['member_id']] = ('temporary ' if event['event'].startswith('StackCatalogSetup.temporaryService') else '') + attributes['service']
    measured_spans = spans(selected)
    for span in measured_spans:
        span['service_name'] = mapped.get(span.get('member_id'), span.get('service'))
        span['offset_seconds'] = round((span['epoch_ms']-begin)/1000, 3)
    validated = command.get('ok') and lifecycle.get('ready' if phase == 'start' else 'restart_ready', False)
    if validated and (not selected or (implementation == 'cli' and ('cli_entry' not in parts or named_span(selected, 'experimental.stack.compositionStart') is None))):
        raise ValueError(f'Missing trace boundary for successful {implementation} {phase}')
    return {'ok': bool(validated), 'seconds': round(command['elapsed_ms']/1000, 3), 'parts': parts, 'spans': measured_spans, 'events': selected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    rows = []
    for file in args.root.rglob('*results.json'):
        data = json.loads(file.read_text())
        if 'pairs' not in data:
            continue
        for pair in data['pairs']:
            for impl, life in pair['results'].items():
                for phase in ('start', 'restart'):
                    if life.get(phase) and 'started_epoch_ms' in life[phase]:
                        rows.append({'source': str(file), 'runtime': data.get('runtime'), 'platform': data.get('host', {}).get('system'), 'mode': pair['mode'], 'sample': pair['sample'], 'implementation': impl, 'phase': phase, **analyze(life, impl, phase)})
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row['platform'], row['runtime'], row['mode'], row['implementation'], row['phase'])].append(row)
    medians = []
    for key, values in grouped.items():
        good = [v for v in values if v['ok']]
        keys = set().union(*(v['parts'].keys() for v in good))
        record = dict(zip(('platform','runtime','mode','implementation','phase'), key))
        record.update(n=len(good), failures=len(values)-len(good), seconds=statistics.median(v['seconds'] for v in good) if good else None, parts={k: statistics.median(v['parts'][k] for v in good if v['parts'].get(k) is not None) for k in sorted(keys) if any(v['parts'].get(k) is not None for v in good)})
        medians.append(record)
        print(json.dumps(record))
    if args.output:
        args.output.write_text(json.dumps({'medians': medians, 'rows': rows}, indent=2)+'\n')


if __name__ == '__main__':
    main()
