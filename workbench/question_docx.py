"""Conservative import of teacher DOCX with numbered questions and inline answers.

Unsupported mathematical objects remain in the source DOCX and are reported; the
import never labels an OCR guess as a verified mathematical expression.
"""
import base64
import html
import mimetypes
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET

from .config import WorkbenchError

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
M='http://schemas.openxmlformats.org/officeDocument/2006/math'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS={'w':W,'m':M}

def parse_docx(path):
    with zipfile.ZipFile(path) as z:
        root=ET.fromstring(z.read('word/document.xml'))
        rels={}
        if 'word/_rels/document.xml.rels' in z.namelist():
            rels={x.get('Id'):x.get('Target') for x in ET.fromstring(z.read('word/_rels/document.xml.rels')) if x.get('TargetMode')!='External'}
        issues=[]
        def math(node):
            name=node.tag.split('}')[-1]
            def child(key):
                el=node.find('m:'+key,NS)
                return math(el) if el is not None else '<mrow></mrow>'
            if name.endswith('Pr'): return ''
            if name=='t': return '<mi>'+html.escape(node.text or '')+'</mi>'
            if name=='f': return '<mfrac>'+child('num')+child('den')+'</mfrac>'
            if name in ('sSup','sSub','sSubSup'):
                tag={'sSup':'msup','sSub':'msub','sSubSup':'msubsup'}[name]
                return '<'+tag+'>'+child('e')+(child('sub') if name!='sSup' else '')+(child('sup') if name!='sSub' else '')+'</'+tag+'>'
            if name=='rad':
                degree=node.find('m:deg',NS)
                if degree is not None and ''.join(degree.itertext()).strip(): return '<mroot>'+child('e')+child('deg')+'</mroot>'
                return '<msqrt>'+child('e')+'</msqrt>'
            if name=='d':
                def delim(key,default):
                    el=node.find('m:dPr/m:'+key,NS)
                    return el.get('{'+M+'}val',default) if el is not None else default
                return '<mrow><mo>'+html.escape(delim('begChr','('))+'</mo>'+''.join(math(e) for e in node.findall('m:e',NS))+'<mo>'+html.escape(delim('endChr',')'))+'</mo></mrow>'
            if name in ('acc','bar','nary','limLow','limUpp','eqArr','m','groupChr'):
                issues.append('unsupported_math:'+name)
            return '<mrow>'+''.join(math(c) for c in node)+'</mrow>'
        def render(node):
            name=node.tag.split('}')[-1]
            if node.tag.startswith('{'+M+'}'):
                return '<math xmlns="http://www.w3.org/1998/Math/MathML">'+math(node)+'</math>'
            if name=='t': return html.escape(node.text or '')
            if name in ('br','cr'): return '<br>'
            if name=='tab': return '　'
            if name in ('pPr','rPr','sectPr'): return ''
            if name in ('blip','imagedata'):
                rid=node.get('{'+R+'}embed') or node.get('{'+R+'}id')
                target=rels.get(rid)
                if target:
                    filename=posixpath.normpath(posixpath.join('word',target))
                    if filename in z.namelist():
                        mime=mimetypes.guess_type(filename)[0] or 'application/octet-stream'
                        if mime in ('image/png','image/jpeg','image/gif','image/webp'):
                            return '<img src="data:'+mime+';base64,'+base64.b64encode(z.read(filename)).decode()+'">'
                        issues.append('unsupported_image:'+filename)
                else: issues.append('missing_image')
                return '<span>[图形需核对原件]</span>'
            if name=='OLEObject': issues.append('embedded_object')
            inside=''.join(render(c) for c in node)
            tag={'p':'p','tbl':'table','tr':'tr','tc':'td'}.get(name)
            return '<'+tag+'>'+inside+'</'+tag+'>' if tag else inside
        items=[]; current=None; section='stem'; title=path.stem; kind=''
        for position,block in enumerate(root.find('w:body',NS),1):
            plain=''.join(block.itertext()).strip()
            match=re.match(r'^\s*(\d{1,3})[.．、]\s*',plain)
            if match and int(match[1])==len(items)+1:
                current={'stem':'','answer':'','analysis':'','stem_html':'','answer_html':'','analysis_html':'',
                         'kind':kind,'tags':[],'source':{'number':int(match[1]),'block':position},'warnings':[]}
                items.append(current); section='stem'
            elif re.match(r'^[一二三四五六七八九十]+[、．.]',plain):
                kind=plain.split('：')[0]; continue
            if current is None: continue
            if '【答案】' in plain or plain.startswith('答案：'): section='answer'
            if '【解析】' in plain or plain.startswith('解析：'): section='analysis'
            issues.clear()
            markup=render(block)
            current[section]+=plain+'\n'; current[section+'_html']+=markup
            current['warnings'].extend(issues)
        if not items: raise WorkbenchError('未识别连续题号；请提供教师版 DOCX 或标准题库 JSON')
        for item in items:
            if not item['answer'].strip() and not item['answer_html']: item['warnings'].append('answer_not_identified')
            item['review_status']='needs_attention' if item['warnings'] else 'unreviewed'
        return {'title':title,'items':items,'metadata':{'importer':'numbered-teacher-docx-v1','source_preserved':True}}
