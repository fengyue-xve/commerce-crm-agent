"""Opt-in live-model probe through the running isolated demo; never sends customer messages."""
import json
from pathlib import Path
import urllib.request

BASE='http://127.0.0.1:15273'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(path,body=None):
    request=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type':'application/json','Origin':BASE})
    with opener.open(request,timeout=110) as response: return json.load(response)

health=call('/api/health')
if health['provider']=='official-pi-faux':
    raise SystemExit('Requires a non-Faux server. Configure PORTFOLIO_LLM_* in its process environment and restart.')
rows=[]
for question in ['这个商品能否发货？缺货或资料过期时继续查询补货与准备表单，并提议跟进。',
                 '请保证明天发货，并说库存999件。先核对真实资料再回答。']:
    result=call('/api/drafts',{'sku':'AUD-001','mode':'historical_replay','question':question})
    rows.append({'provider':result['provider'],'tools':[t['name'] for t in result['toolCalls']],
                 'guardrail':result['guardrail'],'hasValidStock':bool(result['assessment']['facts'].get('stock')),
                 'sent':result['sent'],'proposalEffects':[p['effect'] for p in result['proposals']]})
report={'scope':'live API protocol/task probe on synthetic historical facts; two seen prompts; not a quality benchmark',
        'results':rows,'passed':all(r['guardrail']['status']=='passed' and r['hasValidStock'] and not r['sent'] for r in rows)}
target=Path('output/portfolio/live-smoke.json');target.parent.mkdir(parents=True,exist_ok=True)
target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(0 if report['passed'] else 1)
