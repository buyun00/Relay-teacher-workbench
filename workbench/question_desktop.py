"""Desktop views over the same server Store and immutable question bank."""
import json
from pathlib import Path

from .question_bank import QuestionBank
from .config import WorkbenchError


def command(store, payload):
    args = dict(payload)
    args.pop('workspace_id', None)
    action = args.pop('action', '')
    bank = QuestionBank(store)
    if action == 'catalog':
        with store.connect() as db:
            students = [dict(r) for r in db.execute("SELECT s.id,s.name,COALESCE(group_concat(c.name,' / '),'') AS class_id FROM students s LEFT JOIN memberships m ON m.student_id=s.id LEFT JOIN classes c ON c.id=m.class_id GROUP BY s.id ORDER BY s.name")]
            papers = [dict(r) for r in db.execute('SELECT p.id,p.title,p.student_id,p.created_at,a.stale FROM qb_papers p JOIN artifacts a ON a.id=p.artifact_id ORDER BY p.created_at DESC LIMIT 100')]
            facets = [json.loads(r[0]) for r in db.execute('SELECT r.body FROM qb_revisions r JOIN qb_items i ON r.item_id=i.id AND r.revision=i.revision')]
        return {**bank.batches(), 'students': students, 'papers': papers,
                'tags': sorted({t for b in facets for t in b['tags']}),
                'kinds': sorted({b['kind'] for b in facets if b['kind']})}
    if action == 'preview':
        paper = bank.paper(args['paper_id'])
        return {**paper, 'student_html': Path(paper['files']['student.html']).read_text(encoding='utf-8'),
                'teacher_html': Path(paper['files']['teacher.html']).read_text(encoding='utf-8')}
    if action == 'read':
        result=bank.read(**args)
        cleaning=result['body'].get('cleaning')
        if cleaning:
            original=bank.read(cleaning.get('source_item_id',result['id']),cleaning['source_revision'])
            result['original']=original['body']
        return result
    if action not in {'search', 'read', 'adapt', 'revise', 'compose', 'paper'}:
        raise WorkbenchError('未知题库页面操作')
    return bank.invoke(action, **args)
