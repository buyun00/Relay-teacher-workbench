"""Normalize saved browser DOM plus downloaded image manifests; no network access.

Run on the importing workstation with BeautifulSoup installed. Output is the
server's plain JSON interchange format. Runtime teaching files stay outside Git.
"""
import argparse
import base64
import json
import mimetypes
import re
from pathlib import Path
from bs4 import BeautifulSoup


def normalize(raw_path, manifests, output):
    raw=json.loads(Path(raw_path).read_text(encoding='utf-8'))
    images={}
    for path in manifests:
        manifest=json.loads(Path(path).read_text(encoding='utf-8'))
        for row in (manifest if isinstance(manifest,list) else manifest.get('assets',[])):
            if row.get('path') and Path(row['path']).is_file(): images[row['url']]=row['path']
    items=[]
    for row in raw['items']:
        soup=BeautifulSoup(row['html'],'html.parser')
        stem=soup.select_one('.topic-content')
        if not stem: continue
        warnings=[]
        def part(node):
            if node is None: return '', ''
            node=BeautifulSoup(str(node),'html.parser')
            plain=BeautifulSoup(str(node),'html.parser')
            for script in plain.select('script[type^="math/tex"]'):
                script.replace_with('$'+script.get_text()+'$')
            for extra in plain.select('.MathJax_Preview,.MathJax_CHTML,.MathJax_SVG,.MathJax'):
                extra.decompose()
            for image in plain.select('img'):
                image.replace_with('[图片]')
            txt=plain.get_text(' ',strip=True)
            for formula in node.select('[data-mathml]'):
                formula.replace_with(BeautifulSoup(formula['data-mathml'],'html.parser'))
            for extra in node.select('script,.MathJax_Preview'):
                extra.decompose()
            for image in node.select('img'):
                url=image.get('src','')
                if url.startswith('data:image/'):
                    continue
                path=images.get(url)
                if path:
                    mime=mimetypes.guess_type(path)[0] or 'image/png'
                    image['src']='data:'+mime+';base64,'+base64.b64encode(Path(path).read_bytes()).decode()
                else:
                    warnings.append('image_unavailable:'+url)
                    image.replace_with('[图片未取得，请核对原件]')
            for tag in node.find_all(True):
                for key in list(tag.attrs):
                    if key.startswith('_ng') or key.startswith('on') or key in ('style','id','class','tabindex','role'): del tag[key]
            return txt,str(node)
        stem_text,stem_html=part(stem)
        if '如图' in stem_text and not stem.select('img,svg'):
            warnings.append('diagram_reference_without_image')
        blocks=soup.select('.ans-analy .ana_list')
        answer_node=next((b for b in blocks if b.select_one('.answer') or '【答案】' in b.get_text()),None)
        analysis_node=next((b for b in blocks if '【解析】' in b.get_text()),None)
        answer,answer_html=part(answer_node)
        analysis,analysis_html=part(analysis_node)
        if not answer_node: warnings.append('answer_not_present')
        if not analysis_node or analysis.replace('【解析】','').strip() in ('','略'): warnings.append('analysis_missing_or_abbreviated')
        tags=[e.get_text(strip=True) for e in soup.select('.infordot,.infordot-ci')]
        items.append({'stem':stem_text,'stem_html':stem_html,'answer':answer,'answer_html':answer_html,
            'analysis':analysis,'analysis_html':analysis_html,'tags':list(dict.fromkeys(tags)),
            'kind':row.get('kind',''),'source':{'provider':'zhixue','question_id':row['source_id'],
                'paper_id':raw['paper_id'],'number':row['number']},'warnings':warnings,
            'review_status':'needs_attention' if warnings else 'unreviewed'})
    result={'title':raw['title'],'metadata':{'capture':'browser DOM export, not official Word download',
        'paper_id':raw['paper_id'],'original_dom':Path(raw_path).name},'items':items}
    Path(output).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
    return {'count':len(items),'needs_attention':sum(bool(q['warnings']) for q in items),
            'missing_images':sum(sum(w.startswith('image_unavailable:') for w in q['warnings']) for q in items)}

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('raw'); p.add_argument('output'); p.add_argument('manifests',nargs='+')
    a=p.parse_args(); print(json.dumps(normalize(a.raw,a.manifests,a.output),ensure_ascii=False))
