"""Server-side question library. Immutable revisions, explicit tasks, no model SQL."""
from __future__ import annotations

import copy
import hashlib
import html
import json
from pathlib import Path

from .config import WorkbenchError
from .facts import Facts
from .storage import atomic_write, encode, identifier, now
from .question_html import sanitize


def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise WorkbenchError(label + '不能为空')
    return value.strip()


class QuestionBank:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.executescript(Path(__file__).with_name('question_bank.sql').read_text(encoding='utf-8'))

    @staticmethod
    def body(value):
        if not isinstance(value, dict):
            raise WorkbenchError('题目必须是对象')
        value = copy.deepcopy(value)
        text(value.get('stem'), '题干')
        for key in ('answer', 'analysis', 'kind'):
            if not isinstance(value.get(key, ''), str):
                raise WorkbenchError(key + '必须是文本')
            value.setdefault(key, '')
        if not isinstance(value.get('tags', []), list) or any(not isinstance(x, str) for x in value.get('tags', [])):
            raise WorkbenchError('标签必须是文本数组')
        value.setdefault('tags', [])
        for key in ('stem_html','answer_html','analysis_html'):
            if key in value:
                if not isinstance(value[key],str): raise WorkbenchError('题目 HTML 必须是文本')
                value[key]=sanitize(value[key])
        value.setdefault('review_status', 'unreviewed')
        if value['review_status'] not in ('unreviewed', 'reviewed', 'needs_attention'):
            raise WorkbenchError('审核状态无效')
        encode(value)
        return value

    def import_file(self, path, title=None, tags=None, expected_count=None):
        source = self.store.config.input_file(path)
        if source.suffix.lower() == '.docx':
            from .question_docx import parse_docx
            data = parse_docx(source)
        else:
            data = json.loads(source.read_text(encoding='utf-8-sig'))
        items = data.get('items', [])
        if not items:
            raise WorkbenchError('未提取到题目；原件不会被记为已完成入库')
        if expected_count is not None and len(items) != expected_count:
            raise WorkbenchError(f'题量不符：预期 {expected_count}，实际 {len(items)}')
        bodies = [self.body({**q, 'tags': list(dict.fromkeys(q.get('tags', []) + (tags or [])))}) for q in items]
        asset = self.store.ingest(str(source), 'document', {'purpose': 'question_bank'})
        bid = 'qb_' + asset['sha256'][:24]
        with self.store.transaction() as db:
            old = db.execute('SELECT id FROM qb_batches WHERE source_asset_id=?', (asset['id'],)).fetchone()
            if old:
                return {'batch_id': old[0], 'duplicate': True, 'count': len(bodies)}
            db.execute('INSERT INTO qb_batches VALUES(?,?,?,?,?,?)', (bid, title or data.get('title') or source.stem,
                asset['id'], now(), len(bodies), encode(data.get('metadata', {}))))
            for n, body in enumerate(bodies, 1):
                source_key=body.get('source',{}).get('question_id')
                identity={'provider':body.get('source',{}).get('provider'),'question_id':source_key,
                          'content':{k:body.get(k) for k in ('stem','answer','analysis','stem_html','answer_html','analysis_html')}}
                iid = 'qi_'+hashlib.sha256(encode(identity).encode()).hexdigest()[:24] if source_key else identifier('qi')
                if not db.execute('SELECT 1 FROM qb_items WHERE id=?',(iid,)).fetchone():
                    db.execute('INSERT INTO qb_items(id,created_at,updated_at) VALUES(?,?,?)', (iid, now(), now()))
                    db.execute('INSERT INTO qb_revisions VALUES(?,?,?,?,?)', (iid, 1, encode(body), 'import', now()))
                db.execute('INSERT INTO qb_batch_items VALUES(?,?,?,?)', (bid, n, iid, encode(body.get('source', {'number': n}))))
            self.store.audit(db, 'question_bank.import', bid, {'count': len(bodies), 'source_asset_id': asset['id']})
        return {'batch_id': bid, 'count': len(bodies), 'duplicate': False, 'source_asset_id': asset['id'],
                'needs_attention': sum(x['review_status'] == 'needs_attention' for x in bodies)}

    def batches(self):
        with self.store.connect() as db:
            return {'batches': [dict(r) for r in db.execute('SELECT * FROM qb_batches ORDER BY created_at DESC')]}

    def _read(self, db, item_id, revision=None):
        item = db.execute('SELECT * FROM qb_items WHERE id=?', (item_id,)).fetchone()
        if item is None:
            raise WorkbenchError('题目不存在')
        rev = revision if revision is not None else item['revision']
        row = db.execute('SELECT * FROM qb_revisions WHERE item_id=? AND revision=?', (item_id, rev)).fetchone()
        if row is None:
            raise WorkbenchError('题目版本不存在')
        return {**dict(item), 'current_revision': item['revision'], 'revision': rev,
                'body': json.loads(row['body']), 'reason': row['reason']}

    def read(self, item_id, revision=None):
        with self.store.connect() as db:
            result = self._read(db, item_id, revision)
            result['history'] = [dict(r) for r in db.execute('SELECT revision,reason,created_at FROM qb_revisions WHERE item_id=? ORDER BY revision', (item_id,))]
            return result

    def search(self, query='', tags=None, kind=None, batch_id=None, limit=20, offset=0, review_status=None):
        if not isinstance(limit, int) or not 1 <= limit <= 200 or not isinstance(offset, int) or offset < 0:
            raise WorkbenchError('分页参数无效')
        with self.store.connect() as db:
            rows = db.execute('SELECT i.id,i.revision,r.body FROM qb_items i JOIN qb_revisions r ON r.item_id=i.id AND r.revision=i.revision WHERE (? IS NULL OR EXISTS(SELECT 1 FROM qb_batch_items b WHERE b.item_id=i.id AND b.batch_id=?)) ORDER BY i.created_at,i.id', (batch_id,batch_id))
            matches = []
            for row in rows:
                body = json.loads(row['body'])
                if review_status and body['review_status'] != review_status:
                    continue
                haystack = '\n'.join([body['stem'], body['answer'], body['analysis'], *body['tags']])
                if query.casefold() not in haystack.casefold() or (kind and body['kind'] != kind):
                    continue
                if not set(tags or []).issubset(body['tags']):
                    continue
                matches.append({'id':row['id'], 'revision':row['revision'], 'kind':body['kind'],
                    'tags':body['tags'], 'stem':body['stem'][:1000], 'review_status':body['review_status']})
        return {'total':len(matches), 'items':matches[offset:offset+limit], 'offset':offset, 'limit':limit}

    def revise(self, item_id, expected_revision, changes, reason):
        text(reason, '修改原因')
        if not isinstance(changes, dict) or not changes:
            raise WorkbenchError('修改内容不能为空')
        with self.store.transaction() as db:
            current = self._read(db, item_id)
            if current['revision'] != expected_revision:
                raise WorkbenchError('题目版本已变化，请重新读取')
            body = self.body({**current['body'], **changes})
            # A content edit never inherits the previous quality assertion.
            if any(k in changes for k in ('stem','answer','analysis','stem_html','answer_html','analysis_html')):
                body['review_status'] = 'unreviewed'
            for plain in ('stem','answer','analysis'):
                if plain in changes and plain + '_html' not in changes:
                    body.pop(plain + '_html', None)
            revision = expected_revision + 1
            db.execute('INSERT INTO qb_revisions VALUES(?,?,?,?,?)', (item_id,revision,encode(body),reason,now()))
            db.execute('UPDATE qb_items SET revision=?,updated_at=? WHERE id=?', (revision,now(),item_id))
            # Mark all descendants and all papers depending on them as stale, keeping snapshots.
            dependents = [r[0] for r in db.execute('WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT i.id FROM qb_items i JOIN d ON i.parent_id=d.id) SELECT id FROM d', (item_id,))]
            for iid in dependents:
                db.execute('UPDATE artifacts SET stale=1 WHERE id IN (SELECT p.artifact_id FROM qb_papers p JOIN qb_paper_items pi ON pi.paper_id=p.id WHERE pi.item_id=?)', (iid,))
            self.store.audit(db,'question_bank.revise',item_id,{'revision':revision,'reason':reason})
        return self.read(item_id)

    def adapt(self, item_id, expected_revision, changes, reason):
        text(reason, '改编原因')
        with self.store.transaction() as db:
            source = self._read(db,item_id)
            if source['revision'] != expected_revision:
                raise WorkbenchError('原题版本已变化')
            body = self.body({**source['body'], **changes, 'review_status':'unreviewed'})
            for plain in ('stem','answer','analysis'):
                if plain in changes and plain + '_html' not in changes:
                    body.pop(plain + '_html',None)
            iid = identifier('qi')
            db.execute('INSERT INTO qb_items VALUES(?,?,?,?,?,?)',(iid,1,item_id,expected_revision,now(),now()))
            db.execute('INSERT INTO qb_revisions VALUES(?,?,?,?,?)',(iid,1,encode(body),reason,now()))
            self.store.audit(db,'question_bank.adapt',iid,{'parent':item_id,'revision':expected_revision})
        return self.read(iid)

    def _lineage(self, db, item):
        lineage = [item]
        while item['parent_id']:
            parent = self._read(db,item['parent_id'])
            if parent['revision'] != item['parent_revision']:
                raise WorkbenchError('改编依据的原题已更新，请基于新版本重新改编')
            lineage.append(parent)
            item = parent
        return lineage

    def compose(self, title, selections, purpose, student_id=None, evidence=None):
        text(title,'作业标题'); text(purpose,'教学目的')
        if not isinstance(selections,list) or not selections:
            raise WorkbenchError('必须选择题目')
        pid, aid = identifier('paper'), identifier('artifact')
        with self.store.transaction() as db:
            if student_id:
                self.store.one('students',student_id,db)
            refs = Facts(self.store).sources(evidence,db) if evidence else []
            entries=[]
            for selection in selections:
                item = self._read(db, selection['item_id'])
                if item['revision'] != selection['revision']:
                    raise WorkbenchError('选题已过期，请重新查找')
                for ancestor in self._lineage(db,item):
                    for row in db.execute('SELECT b.source_asset_id FROM qb_batches b JOIN qb_batch_items bi ON bi.batch_id=b.id WHERE bi.item_id=?',(ancestor['id'],)):
                        ref={'kind':'asset','id':row[0],'revision':1}
                        if ref not in refs: refs.append(ref)
                task = selection.get('task',{})
                if not isinstance(task,dict): raise WorkbenchError('任务必须是对象')
                entries.append({'item_id':item['id'],'revision':item['revision'],'body':item['body'],'task':task})
            refs = Facts(self.store).sources(refs,db)
            manifest={'id':pid,'title':title,'student_id':student_id,'purpose':purpose,'evidence':refs,'items':entries,
                      'status':'draft','teaching_quality_verified':False}
            folder=self.store.root/'artifacts'/aid
            atomic_write(folder/'manifest.json',encode(manifest).encode('utf-8'))
            for teacher in (False,True):
                atomic_write(folder/('teacher.html' if teacher else 'student.html'),self._render(manifest,teacher).encode('utf-8'))
            db.execute('INSERT INTO artifacts(id,kind,title,path,sources,created_at,validation) VALUES(?,?,?,?,?,?,?)',
                (aid,'exercise',title,f'artifacts/{aid}/student.html',encode(refs),now(),encode({'scope':'question_versions','teaching_quality_verified':False})))
            db.execute('INSERT INTO qb_papers VALUES(?,?,?,?,?,?,?)',(pid,title,student_id,purpose,encode(refs),aid,now()))
            for n,entry in enumerate(entries,1):
                db.execute('INSERT INTO qb_paper_items VALUES(?,?,?,?,?)',(pid,n,entry['item_id'],entry['revision'],encode(entry['task'])))
            self.store.audit(db,'question_bank.compose',pid,{'count':len(entries),'student_id':student_id})
        return self.paper(pid)

    @staticmethod
    def _render(manifest,teacher):
        e=html.escape
        blocks=[]
        for n,item in enumerate(manifest['items'],1):
            body,task=item['body'],item['task']
            blocks.append(f'<section><h2>第{n}题</h2>'+body.get('stem_html',f'<p>{e(body["stem"])}</p>'))
            for key,label in [('instruction','任务'),('hint','提示')]:
                if task.get(key): blocks.append(f'<p><b>{label}：</b>{e(str(task[key]))}</p>')
            if teacher:
                for key,label in [('answer','答案'),('analysis','解析')]:
                    blocks.append(f'<h3>{label}</h3>'+body.get(key+'_html',f'<p>{e(body.get(key,""))}</p>'))
                blocks.append(f'<p class="meta">来源 {e(item["item_id"])} / v{item["revision"]}；{e(body["review_status"])}</p>')
                if task.get('reason'): blocks.append(f'<p>安排依据：{e(str(task["reason"]))}</p>')
            else: blocks.append('<div class="space"></div>')
            blocks.append('</section>')
        return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+e(manifest['title'])+'</title><style>body{max-width:850px;margin:32px auto;font:17px/1.8 system-ui;padding:24px}section{border-top:1px solid #bbb;padding:16px 0}img{max-width:100%}table{border-collapse:collapse}td{padding:6px;border:1px solid #ccc}.space{height:100px}.meta{font-size:12px;color:#666}p{white-space:pre-wrap}math{font-size:1.15em}@media print{body{margin:0;padding:0}section{break-inside:avoid}}</style><h1>'+e(manifest['title'])+'</h1><p>'+('教师版' if teacher else '学生版')+'</p>'+''.join(blocks)+'</html>'

    def paper(self,paper_id):
        with self.store.connect() as db:
            row=db.execute('SELECT p.*,a.stale,a.path FROM qb_papers p JOIN artifacts a ON a.id=p.artifact_id WHERE p.id=?',(paper_id,)).fetchone()
            if row is None: raise WorkbenchError('作业不存在')
            result=dict(row)
            try: Facts(self.store).sources(json.loads(row['evidence']),db)
            except WorkbenchError: result['stale']=1
            result['items']=[dict(r) for r in db.execute('SELECT * FROM qb_paper_items WHERE paper_id=? ORDER BY position',(paper_id,))]
            folder=self.store.root/'artifacts'/row['artifact_id']
            result['files']={name:str(folder/name) for name in ('student.html','teacher.html','manifest.json')}
            result['available']=all(Path(p).is_file() for p in result['files'].values())
            result['delivery_status']='not_sent'
            return result

    def record_attempt(self,paper_id,position,response,assistance=None,assessment=None):
        text(response,'作答内容')
        attempt=identifier('attempt')
        with self.store.transaction() as db:
            if not db.execute('SELECT 1 FROM qb_paper_items WHERE paper_id=? AND position=?',(paper_id,position)).fetchone():
                raise WorkbenchError('作业题号不存在')
            db.execute('INSERT INTO qb_attempts VALUES(?,?,?,?,?,?,?)',(attempt,paper_id,position,response,encode(assistance or {}),encode(assessment or {}),now()))
        return {'id':attempt,'persisted':True,'mastery_inferred':False}

    def invoke(self,action,**args):
        actions={'import':self.import_file,'batches':self.batches,'search':self.search,'read':self.read,
                 'revise':self.revise,'adapt':self.adapt,'compose':self.compose,'paper':self.paper,'attempt':self.record_attempt}
        if action not in actions: raise WorkbenchError('未知题库操作')
        return actions[action](**args)
