#!/usr/bin/env python3
"""Summarize matched startup traces without adding overlapping service spans."""
import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path


def event_at(events, name):
    return next((e['epoch_ms'] for e in events if e['event'] == name), None)


def duration(events, begin, end):
    left, right = event_at(events, begin), event_at(events, end)
    return None if left is None or right is None else round((right-left)/1000, 3)


def spans(events):
    pending = defaultdict(list)
    result = []
    for event in events:
        name = event.get('event', '')
        if not name.endswith(('.begin', '.end')):
            continue
        stem, suffix = name.rsplit('.', 1)
        key = (stem, event.get('pid'), event.get('trace_id'), event.get('member_id'), event.get('service'), event.get('operation'), event.get('suboperation'))
        if suffix == 'begin':
            pending[key].append(event)
        elif pending[key]:
            start = pending[key].pop(0)
            result.append({**start, 'event': stem, 'end_epoch_ms': event['epoch_ms'], 'seconds': round((event['epoch_ms']-start['epoch_ms'])/1000, 3)})
    return result


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
        handler = event_at(selected, 'cli.handler.begin')
        db = event_at(selected, 'database.start.begin')
        if handler is not None:
            parts['cli_entry'] = round((handler-begin)/1000, 3)
        if handler is not None and db is not None:
            parts['stack_setup'] = round((db-handler)/1000, 3)
        parts['database'] = duration(selected, 'database.start.begin', 'database.ready')
        parts['catalog'] = duration(selected, 'catalog.migrations.begin', 'catalog.migrations.end') or 0
        parts['project_sql'] = duration(selected, 'project.migrations.begin', 'project.migrations.end') or 0
        parts['composition'] = duration(selected, 'composition.start.begin', 'composition.start.end')
        parts['other'] = round(command['elapsed_ms']/1000 - sum(x for x in parts.values() if x is not None), 3)
    else:
        parts = {key.removesuffix('_ms'): round(value/1000, 3) for key, value in parse_output(command).get('timings', {}).items()}
        parts['entry_and_exit'] = round(command['elapsed_ms']/1000-sum(parts.values()), 3)
    mapped = {}
    for event in events:
        for member in event.get('members', []):
            mapped[member['id']] = member['service']
        if event.get('service') and event.get('member_id'):
            mapped[event['member_id']] = 'temporary ' + event['service'] if event['event'].startswith('catalog.') else event['service']
    measured_spans = spans(selected)
    for span in measured_spans:
        span['service_name'] = mapped.get(span.get('member_id'), span.get('service'))
        span['offset_seconds'] = round((span['epoch_ms']-begin)/1000, 3)
    return {'ok': command.get('ok'), 'seconds': round(command['elapsed_ms']/1000, 3), 'parts': parts, 'spans': measured_spans, 'events': selected}


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
