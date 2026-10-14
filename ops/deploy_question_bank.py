"""Add the bank to the existing teacher plugin; preserve unrelated live changes.

Run inside the Hermes container as the hermes user, with this checkout's bank-only
staging directory as argv[1]. No service or host restart is performed.
"""
import ast
import json
from pathlib import Path
import shutil
import sqlite3
import sys
from datetime import datetime, timezone

stage=Path(sys.argv[1])
target=Path('/opt/data/profiles/teacher-workbench/plugins/teacher-workbench')
stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=stage/('backup-question-bank-'+stamp)
backup.mkdir(parents=True)
settings=json.loads(Path('/opt/data/profiles/teacher-workbench/teacher-workbench.json').read_text())
db_path=Path(settings['data_root'])/'database/workbench.sqlite'
with sqlite3.connect(db_path) as src, sqlite3.connect(backup/'workbench.sqlite') as dst:
    src.backup(dst)
    assert dst.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
native=(target/'workbench/native.py').read_text()
service=(target/'workbench/service.py').read_text()
plugin=(target/'plugin.yaml').read_text()
if 'schema("teacher_question_bank"' not in native:
    source=(stage/'native.py').read_text()
    tree=ast.parse(source)
    schemas=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SCHEMAS' for t in n.targets))
    entry=next(n for n in schemas.value.elts if isinstance(n,ast.Call) and n.args and isinstance(n.args[0],ast.Constant) and n.args[0].value=='teacher_question_bank')
    assert native.count('SCHEMAS = [')==1
    native=native.replace('SCHEMAS = [','SCHEMAS = [\n    '+ast.get_source_segment(source,entry)+',',1)
if 'tool == "teacher_question_bank"' not in service:
    anchor='        context = context or {}\n'
    assert service.count(anchor)==1
    service=service.replace(anchor,anchor+'        if tool == "teacher_question_bank":\n            from .question_bank import QuestionBank\n            return QuestionBank(self.store).invoke(action, **a)\n',1)
if '  - teacher_question_bank\n' not in plugin:
    assert plugin.count('provides_tools:\n')==1
    plugin=plugin.replace('provides_tools:\n','provides_tools:\n  - teacher_question_bank\n',1)
for name,content in [('workbench/native.py',native),('workbench/service.py',service),('plugin.yaml',plugin)]:
    if name.endswith('.py'): compile(content,name,'exec')
    saved=backup/name; saved.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(target/name,saved)
for name in ['question_bank.py','question_bank.sql','question_html.py','question_docx.py']:
    dest=target/'workbench'/name
    if dest.exists(): shutil.copy2(dest,backup/name)
    shutil.copy2(stage/name,dest)
for name,content in [('workbench/native.py',native),('workbench/service.py',service),('plugin.yaml',plugin)]:
    (target/name).write_text(content)
sys.path.insert(0,str(target))
from workbench.config import Config
from workbench.storage import Store
from workbench.question_bank import QuestionBank
store=Store(Config.load(home=Path('/opt/data/profiles/teacher-workbench')))
QuestionBank(store)
print(json.dumps({'backup':str(backup),'database':str(store.db_path),'schema':'ready','services_restarted':False}))
