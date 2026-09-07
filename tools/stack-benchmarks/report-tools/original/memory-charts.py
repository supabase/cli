#!/usr/bin/env python3
"""Process memory figures. Exact values from process-memory-data.json."""
import json, math
from charts import OUT, PAPER, MUTED, FAINT, GREEN, GREEN_SOFT, BASE, header, t, rect, line, write_chart
# Data is supplied by the data-driven wrapper before rendering.
D={}
REPORT={"starts": 0, "snapshots": 0, "windowSeconds": "30–40"}

def value(platform,case,metric='rssMiB'):
    return D['cases'][platform][case]['metrics'][metric]['median']

def top(eyebrow,headline,subtitle,description):
    p=header(headline,description)
    p += [t(92,78,eyebrow,17,GREEN,'700',letter=2.3),t(92,176,headline,80,PAPER,'900'),t(94,231,subtitle,23,MUTED,'500'),line(92,274,1508,274,'#26322c')]
    return p

def foot(p,one,two):
    p += [line(92,923,1508,923,'#26322c'),t(92,955,one,17,PAPER,'600'),t(92,981,two,16,MUTED),t(1508,981,'supabase.com',13,FAINT,'600','end'),'</svg>']

def paired(mode):
    baseline='legacy-default' if mode=='default' else 'legacy-pooler'
    groups=[(platform,runtime,value(platform,baseline),value(platform,runtime+'-'+mode)) for runtime in ['docker','native'] for platform in ['linux','macos']]
    reduction=[100*(1-new/old) for _,_,old,new in groups]
    if min(reduction) > 0:
        headline=f'{min(reduction):.0f}–{max(reduction):.0f}% lower RSS'
    elif max(reduction) < 0:
        headline=f'{abs(max(reduction)):.0f}–{abs(min(reduction)):.0f}% higher RSS'
    else:
        headline='full-stack RSS: mixed results'
    subtitle=('Database running; other services prepared and dormant.' if mode=='default' else 'Legacy baseline includes the pooler, matching the new eager service capabilities.')
    p=top('LOCAL STACK · '+mode.upper()+' MODE · PROCESS RSS',headline,subtitle,'Summed resident process memory in MiB. Includes the new stack Supervisor; lower is better.')
    p += [rect(958,298,18,18,BASE,4),t(986,313,'CURRENT CLI'+(' + POOLER' if mode=='eager' else ''),14,MUTED,'700'),rect(1280,298,18,18,GREEN,4),t(1308,313,'NEW STACK',14,GREEN_SOFT,'700')]
    ceiling=math.ceil(max(max(a,b) for _,_,a,b in groups)/1024)*1024
    scale=335/ceiling;bottom=751
    for tick in range(0,ceiling+1,1024):
        y=bottom-tick*scale
        p += [line(136,y,1495,y,'#53615a',1,'6 10',.4),t(119,y+5,f'{tick:,}',14,MUTED,'500','end')]
    p.append(t(92,369,'MiB',15,MUTED,'700'))
    for i,(platform,runtime,old,new) in enumerate(groups):
        cx=306+i*344
        for x,val,fill in [(cx-89,old,BASE),(cx+13,new,'url(#greenBar)')]:
            h=val*scale
            p += [rect(x,bottom-h,76,h,fill,9),t(x+38,bottom-h-16,f'{val:,.0f}',23,PAPER,'700','middle')]
        delta=100*(new/old-1)
        badge=f'{abs(delta):.1f}% '+('less' if delta<0 else 'more')
        p += [t(cx,801,('Ubuntu' if platform=='linux' else 'macOS')+' · '+runtime,21,PAPER,'700','middle'),t(cx,841,badge,25,GREEN_SOFT if delta<0 else PAPER,'700','middle'),t(cx,871,'vs current CLI'+(' + pooler' if mode=='eager' else ''),16,MUTED,'500','middle')]
    foot(p,f"Lower = less RSS · {REPORT['starts']} starts · {REPORT['snapshots']} snapshots · requested {REPORT['windowSeconds']}s after readiness and preparation",'Supervisor + helpers included; RSS repeats shared pages. Docker engine and VM excluded.')
    write_chart('memory-'+mode+'-rss',''.join(p))

def pss():
    cases=['legacy-pooler','docker-default','native-default','docker-eager','native-eager']
    labels=['Current CLI + pooler','New Docker · default','New native · default','New Docker · eager','New native · eager']
    values=[value('linux',c,'pssMiB') for c in cases];old=values[0]
    p=top('UBUNTU 22.04 · PROPORTIONAL SET SIZE','a clearer view of Linux RAM','PSS apportions shared pages between processes. Lower is better.','Linux stack process PSS in MiB; legacy with pooler compared to new default and eager runtimes.')
    ceiling=math.ceil(max(values)/500)*500;left=490;width=875
    for tick in range(0,ceiling+1,500):
        x=left+tick/ceiling*width
        p += [line(x,360,x,827,'#53615a',1,'6 10',.4),t(x,858,f'{tick:,}',16,MUTED,'500','middle')]
    p.append(t(1430,858,'MiB',16,MUTED,'700'))
    for i,(label,v) in enumerate(zip(labels,values)):
        y=383+i*90
        p += [t(92,y+34,label,25,PAPER,'700'),rect(left,y,v/ceiling*width,49,BASE if i==0 else 'url(#greenBar)',8),t(left+v/ceiling*width+18,y+34,f'{v:,.0f}',27,PAPER,'700')]
    foot(p,f"{REPORT['starts']} starts · {REPORT['snapshots']} snapshots · same Linux RSS/PSS collection method · Supervisor included",'Default runs fewer services. PSS is process memory, not whole-machine RAM; engine/VM excluded.')
    write_chart('memory-linux-pss',''.join(p))

if __name__ == '__main__':
    paired('default')
    paired('eager')
    pss()
