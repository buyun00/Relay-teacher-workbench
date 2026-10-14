"""Canonical text/LaTeX -> offline, non-executable MathML for all clients."""
import json
import re
import subprocess
from html import escape
from pathlib import Path
from .config import WorkbenchError


def render_many(values):
    result=subprocess.run(['node',str(Path(__file__).with_suffix('.cjs'))],input=json.dumps(values,ensure_ascii=False),
                          text=True,encoding='utf-8',capture_output=True,timeout=30)
    if result.returncode:
        raise WorkbenchError('公式无法渲染，请检查 LaTeX：'+result.stderr.strip()[:400])
    return json.loads(result.stdout)


def apply_rendered(body):
    """Render only canonical content; source comparison remains a previous revision."""
    values=[body[k] for k in ('stem','answer','analysis')]+[o['text'] for o in body.get('options',[])]
    rendered=render_many(values)
    figures={f['id']:f for f in body.get('figures',[])}
    def insert_figures(value):
        def replace(match):
            f=figures.get(match[1])
            if not f: return '【图形缺失，待核对】'
            return '<img src="'+escape(f['src'],quote=True)+'" alt="'+escape(f.get('description','保留的几何示意图'),quote=True)+'">'
        return re.sub(r'\[\[figure:([a-f0-9]+)\]\]',replace,value)
    for i,k in enumerate(('stem','answer','analysis')): body[k+'_html']=insert_figures(rendered[i])
    for i,o in enumerate(body.get('options',[])):
        body['stem_html']+='<p>'+escape(o['label'])+'. '+insert_figures(rendered[i+3])+'</p>'
    return body
