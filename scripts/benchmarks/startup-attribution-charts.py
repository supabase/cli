#!/usr/bin/env python3
"""Render startup phase bars and a service timeline from measured attribution data."""
import argparse
import json
import statistics
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

BG, FG, MUTED = '#0b0d0c', '#f4f7f4', '#9ca9a2'
COLORS = ['#637169', '#a8f5ce', '#edc976', '#3ecf8e', '#648db1']
plt.rcParams.update({'figure.facecolor': BG, 'axes.facecolor': BG, 'text.color': FG, 'axes.labelcolor': MUTED, 'xtick.color': MUTED, 'ytick.color': FG, 'font.family': 'sans-serif', 'font.size': 12, 'svg.fonttype': 'none'})


def representative(rows):
    median = statistics.median(r['seconds'] for r in rows)
    return min(rows, key=lambda r: abs(r['seconds'] - median))


def style(ax):
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(axis='both', length=0)
    ax.grid(axis='x', color='#26322c', linewidth=.7)
    ax.set_axisbelow(True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('summary', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = json.loads(args.summary.read_text())
    rows = [r for r in data['rows'] if r['ok'] and r['implementation'] == 'cli' and r['phase'] == 'start']
    chosen = []
    for platform, runtime in [('Linux','native'),('Linux','docker'),('Darwin','native')]:
        for mode in ('default','eager'):
            group = [r for r in rows if (r['platform'], r['runtime'], r['mode']) == (platform,runtime,mode)]
            if group:
                chosen.append(representative(group))
    args.output.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(15,8))
    fig.subplots_adjust(left=.21, right=.94, top=.73, bottom=.16)
    fig.text(.055,.92,'LOCAL STACK  /  STARTUP ATTRIBUTION',color='#3ecf8e',size=12,weight='bold')
    fig.text(.055,.85,'Where startup time goes',size=34,weight='bold')
    fig.text(.055,.79,'Cached artifacts · fresh database · actual median-nearest runs, 3 samples per case',color=MUTED,size=13)
    labels = []
    for y, row in enumerate(chosen):
        p = row['parts']
        values = [p.get('cli_entry',0)+p.get('stack_setup',0), p.get('database',0), p.get('catalog',0)+p.get('project_sql',0), p.get('composition',0), p.get('other',0)]
        left = 0
        for value,color in zip(values,COLORS):
            ax.barh(y,value,left=left,color=color,height=.54)
            if value > 1.15:
                ax.text(left+value/2,y,f'{value:.1f}s',ha='center',va='center',color=BG,weight='bold',size=11)
            left += value
        ax.text(left+.25,y,f"{row['seconds']:.1f}s",va='center',weight='bold',size=12)
        labels.append(f"{'Ubuntu' if row['platform']=='Linux' else 'macOS'} · {row['runtime']}\n{row['mode']}")
    ax.set_yticks(range(len(chosen)),labels)
    ax.invert_yaxis()
    ax.set_xlim(0,max(r['seconds'] for r in chosen)*1.12)
    ax.set_xlabel('Seconds from command launch')
    style(ax)
    labels = ['CLI + stack setup','Postgres initialization','Service schemas + project SQL','Composition startup','Other / output']
    fig.legend(handles=[Patch(color=c,label=l) for c,l in zip(COLORS,labels)],loc='lower center',ncol=3,frameon=False,bbox_to_anchor=(.55,.025),labelcolor=MUTED)
    for ext in ('png','svg'):
        fig.savefig(args.output/f'phase-breakdown.{ext}',dpi=160,facecolor=BG)
    plt.close(fig)
    group = [r for r in rows if r['platform']=='Linux' and r['runtime']=='docker' and r['mode']=='eager']
    if not group:
        return
    row = representative(group)
    services = {}
    for span in row['spans']:
        if span['event'] not in ('service.launch','service.ready') or not span.get('service_name'):
            continue
        item = services.setdefault(span['member_id'],{'name':span['service_name'],'spans':[]})
        item['spans'].append(span)
    ordered = sorted(services.values(),key=lambda item:min(s['offset_seconds'] for s in item['spans']))
    fig,ax=plt.subplots(figsize=(15,max(7,len(ordered)*.38+3)))
    fig.subplots_adjust(left=.19,right=.96,top=.77,bottom=.1)
    fig.text(.055,.94,'UBUNTU · DOCKER · EAGER',color='#3ecf8e',size=12,weight='bold')
    fig.text(.055,.87,'Services overlap; schema setup is sequential',size=25,weight='bold')
    fig.text(.055,.815,f"One measured run · {row['seconds']:.2f}s end to end · launch and readiness waits shown separately",color=MUTED,size=12)
    for y,item in enumerate(ordered):
        for span in item['spans']:
            ax.barh(y,max(span['seconds'],.015),left=span['offset_seconds'],height=.6,color='#637169' if span['event']=='service.launch' else '#edc976' if item['name'].startswith('temporary') else '#3ecf8e')
    ax.set_yticks(range(len(ordered)),[item['name'] for item in ordered]);ax.invert_yaxis()
    ax.set_xlim(0,row['seconds']);ax.set_xlabel('Seconds from CLI process launch');style(ax)
    for ext in ('png','svg'):
        fig.savefig(args.output/f'service-timeline.{ext}',dpi=160,facecolor=BG)
    plt.close(fig)


if __name__=='__main__':
    main()
