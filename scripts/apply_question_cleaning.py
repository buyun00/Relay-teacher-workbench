"""Snapshot or apply a reviewed cleaning run with optimistic source revisions.

Models never call this or write the database. Missing/uncertain recognition and
answer checks remain explicit; original revisions and images remain available.
"""
import json
import re
import sqlite3
import sys
from pathlib import Path
from workbench.config import Config, WorkbenchError
from workbench.storage import Store
from workbench.question_bank import QuestionBank

root=Path(sys.argv[1]);mode=sys.argv[2]
store=Store(Config.load(home=Path('/opt/data/profiles/teacher-workbench')))
bank=QuestionBank(store)
if mode=='snapshot':
    if (root/'source-revisions.json').exists(): raise SystemExit('Snapshot already exists; preserving original baseline')
    with store.connect() as db, sqlite3.connect(root/'before-cleaning.sqlite') as backup:
        db.backup(backup)
        rows=db.execute('SELECT i.id,i.revision,r.body FROM qb_items i JOIN qb_revisions r ON i.id=r.item_id AND i.revision=r.revision WHERE i.parent_id IS NULL').fetchall()
    refs={json.loads(r['body']).get('source',{}).get('question_id'):{'id':r['id'],'revision':r['revision']} for r in rows}
    refs.pop(None,None)
    (root/'source-revisions.json').write_text(json.dumps(refs))
    print(json.dumps({'snapshotted':len(refs)}))
elif mode=='apply':
    refs=json.loads((root/'source-revisions.json').read_text());cleaned=json.loads((root/'cleaned.json').read_text())
    if len(cleaned)!=450 or len({q['id'] for q in cleaned})!=450: raise SystemExit('Expected exactly 450 distinct cleaned candidates')
    journal=root/'applied.jsonl';done={r['source_id']:r for r in map(json.loads,journal.read_text().splitlines())} if journal.exists() else {}
    # Validate the complete run before starting any business revisions.
    for q in cleaned:
        for step,allowed,fields in [('solve',('solved','uncertain','insufficient'),('answer','reasoning')),('compare',('consistent','mismatch','uncertain','insufficient'),('reason','suggested_answer'))]:
            result=json.loads((root/step/(q['id']+'.json')).read_text())
            if result.get('id')!=q['id'] or result.get('status') not in allowed or any(not isinstance(result.get(k),str) for k in fields):
                raise SystemExit('Invalid '+step+' result: '+q['id'])
        if q['id'] not in done and bank.read(refs[q['id']]['id'])['revision']!=refs[q['id']]['revision']:
            raise SystemExit('Teacher source changed before application: '+q['id'])
    for q in cleaned:
        if q['id'] in done: continue
        ref=refs[q['id']];current=bank.read(ref['id'])
        if current['revision']!=ref['revision']: raise SystemExit('Source version changed; preserve teacher edit: '+q['id'])
        check_file=root/'compare'/(q['id']+'.json');solution_file=root/'solve'/(q['id']+'.json')
        if not check_file.exists() or not solution_file.exists(): raise SystemExit('Answer verification not completed: '+q['id'])
        check=json.loads(check_file.read_text());solution=json.loads(solution_file.read_text())
        check['solution']=solution.get('reasoning','');check['independent_answer']=solution.get('answer','')
        check['human_verified']=False
        if q['uncertainties'] and check['status']=='consistent':
            check['status']='uncertain';check['reason']='仍有识别或原件缺失问题；不能认定核对一致。'+check.get('reason','')
        if solution.get('status')!='solved' and check['status']=='consistent':
            check['status']='uncertain';check['reason']='独立求解未能确定结果。'+check.get('reason','')
        warnings=[w['field']+'：'+w['reason'] for w in q['uncertainties']]
        if check['status']!='consistent': warnings.append('答案核对：'+check.get('reason','待核对'))
        changes={k:q[k] for k in ('format','stem','options','answer','analysis','figures')}
        changes.update({'warnings':warnings,'answer_check':check,
          'cleaning':{'source_item_id':ref['id'],'source_revision':ref['revision'],'image_count':q['image_count'],
                      'uncertainties':q['uncertainties'],'run':root.name,'machine_transcribed':True},
          'review_status':'needs_attention' if warnings else 'unreviewed'})
        try: result=bank.revise(ref['id'],ref['revision'],changes,'图片转文字与 LaTeX；保留原图，独立求解并核对原答案')
        except WorkbenchError as exc:
            if '公式无法渲染' not in str(exc): raise
            # Keep every recognized character editable, but visibly flag unresolved syntax.
            # Full original model responses remain in the cleaning run for correction.
            warnings.append('LaTeX 语法待核对：'+str(exc))
            for k in ('stem','answer','analysis'): changes[k]=changes[k].replace('$','＄')
            changes['options']=[{**o,'text':o['text'].replace('$','＄')} for o in changes['options']]
            changes['review_status']='needs_attention';changes['answer_check']={**check,'status':'uncertain','reason':'公式语法未通过校验；'+check.get('reason','')}
            changes['cleaning']['uncertainties']=[*q['uncertainties'],{'field':'formula','reason':'公式语法需人工修复，临时用全角美元符显示原转写'}]
            result=bank.revise(ref['id'],ref['revision'],changes,'图片转写；公式语法待核对，保留原件')
        entry={'source_id':q['id'],'item_id':ref['id'],'revision':result['revision'],'answer_status':result['body']['answer_check']['status'],'warnings':len(result['body']['warnings'])}
        with journal.open('a') as f: f.write(json.dumps(entry,ensure_ascii=False)+'\n')
        print(json.dumps(entry),flush=True)
else: raise SystemExit('Mode must be snapshot or apply')
