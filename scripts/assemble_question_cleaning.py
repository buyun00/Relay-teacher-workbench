"""Join transcription with recovered TeX; prepare answer-blind solving inputs."""
import json
import re
import sys
from pathlib import Path

SYMBOLS={'⊥':r'\perp ','∥':r'\parallel ','⊂':r'\subset ','⊆':r'\subseteq ','⊄':r'\not\subset ',
         '⊃':r'\supset ','⊇':r'\supseteq ','∈':r'\in ','∉':r'\notin ','∀':r'\forall ','∃':r'\exists ',
         '∧':r'\land ','∨':r'\lor ','∵':r'\because ','∴':r'\therefore ','≌':r'\cong ',
         '％':r'\%','﹡':'*','Ⅰ':r'\mathrm{I}','Ⅱ':r'\mathrm{II}','Ⅲ':r'\mathrm{III}',' ':' '}

def canonical_math(value):
    def replace(match):
        result=''.join(SYMBOLS.get(c,c) for c in match[0])
        # Source MathJax sometimes wraps a single mathematical symbol in text{}.
        # Once normalized to a math command it must return to math mode.
        return re.sub(r'\\text\{(\\(?:land|lor|because|therefore|forall|exists|subseteq|subset|supseteq|supset|perp|parallel|in|notin)\s*)\}',r'\1',result)
    return re.sub(r'\$\$[\s\S]*?\$\$|\$[^$]*?\$',replace,value)


def assemble(root):
    data=json.loads((root/'prepared.json').read_text())
    originals={r['id']:r for r in data['images']}
    ocr={p.stem:json.loads(p.read_text()) for p in (root/'ocr').glob('*.json')}
    cleaned=[]; solve=[]
    for q in data['questions']:
        fields=[q['stem'],q['answer'],q['analysis']]+[o['text'] for o in q['options']]
        needed=set(re.findall(r'\[\[image:([a-f0-9]+)\]\]',' '.join(fields)))
        if not needed.issubset(ocr): continue
        warnings=list(q['warnings']);figures={}
        def convert(value,field):
            def replace(match):
                key=match[1];r=ocr[key]
                if r.get('uncertain') or r.get('kind')=='unreadable': warnings.append({'field':field,'image_id':key,'reason':r.get('reason') or '图中文字识别不确定'})
                text=r.get('text','')
                if r.get('kind') in ('diagram','mixed'):
                    figures[key]={'id':key,'src':originals[key]['original'],'description':text}
                    return text+'\n[[figure:'+key+']]'
                return text if text else '【图片内容无法辨认，待核对】'
            value=re.sub(r'\[\[image:([a-f0-9]+)\]\]',replace,value)
            value=re.sub(r'\\\[([\s\S]*?)\\\]',lambda m:'$$'+m[1]+'$$',value)
            value=re.sub(r'\\\(([\s\S]*?)\\\)',lambda m:'$'+m[1]+'$',value)
            value=value.replace('【答案】','').replace('【解析】','').strip()
            return canonical_math(value)
        c={'id':q['source_id'],'batch':q['batch'],'number':q['number'],'format':'latex',
           'stem':convert(q['stem'],'stem'),'options':[{'label':o['label'],'text':convert(o['text'],'option_'+o['label'])} for o in q['options']],
           'answer':convert(q['answer'],'answer'),'analysis':convert(q['analysis'],'analysis')}
        if not c['answer']: warnings.append({'field':'answer','reason':'原答案缺失'})
        if not c['analysis'] or c['analysis']=='略': warnings.append({'field':'analysis','reason':'原解析缺失或省略'})
        if 'diagram_reference_without_image' in q['original_warnings']: warnings.append({'field':'stem','reason':'题干引用图形，但原采集未取得图形'})
        c['figures']=list(figures.values());c['uncertainties']=warnings
        c['image_count']=len(needed);c['image_ids']=sorted(needed)
        cleaned.append(c)
        visible_figures=set(re.findall(r'\[\[figure:([a-f0-9]+)\]\]',c['stem']+' '.join(o['text'] for o in c['options'])))
        solve.append({k:c[k] for k in ('id','stem','options')}|{'figures':[f for f in c['figures'] if f['id'] in visible_figures],
            'uncertainties':[w for w in warnings if w['field'] not in ('answer','analysis')]})
    (root/'cleaned.json').write_text(json.dumps(cleaned,ensure_ascii=False))
    (root/'solve-input.json').write_text(json.dumps(solve,ensure_ascii=False))
    comparison=[]
    for q in cleaned:
        source=root/'solve'/(q['id']+'.json')
        if source.exists(): comparison.append({k:q[k] for k in ('id','stem','options','answer','analysis','uncertainties','figures')}|{'independent_solution':json.loads(source.read_text())})
    (root/'compare-input.json').write_text(json.dumps(comparison,ensure_ascii=False))
    print(json.dumps({'ocr':len(ocr),'ready_questions':len(cleaned),'compare_ready':len(comparison)}),flush=True)

if __name__=='__main__': assemble(Path(sys.argv[1]))
