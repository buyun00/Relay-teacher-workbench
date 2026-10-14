"""Recover original TeX and prepare image transcription inputs outside the repo.

Usage: python prepare_question_cleaning.py MATERIALS_DIR OUTPUT_DIR
Requires BeautifulSoup and Pillow on the importing workstation only.
"""
import base64
import hashlib
import json
import re
import sys
from io import BytesIO
from pathlib import Path
from bs4 import BeautifulSoup
from PIL import Image, ImageChops, ImageOps


def prepare(materials, output):
    images, questions = {}, []
    for name in ('logic','sets','quadratic'):
        raw=json.loads((materials/(name+'-dom.json')).read_text(encoding='utf-8'))
        old=json.loads((materials/(name+'.json')).read_text(encoding='utf-8'))
        by_source={q['source']['question_id']:q for q in old['items']}
        files={}
        for manifest in materials.glob(name+'-*.json'):
            if manifest.name.endswith('-dom.json'): continue
            data=json.loads(manifest.read_text(encoding='utf-8'))
            for entry in data if isinstance(data,list) else data.get('assets',[]):
                if entry.get('path') and Path(entry['path']).is_file(): files[entry['url']]=Path(entry['path'])
        for row in raw['items']:
            original=by_source[row['source_id']]
            soup=BeautifulSoup(row['html'],'html.parser')
            warnings=[]
            def part(node, field):
                if node is None: return ''
                node=BeautifulSoup(str(node),'html.parser')
                for script in node.select('script[type^="math/tex"]'):
                    script.replace_with('$'+script.get_text()+'$')
                for extra in node.select('.MathJax_Preview,.MathJax_CHTML,.MathJax_SVG,.MathJax,script,style'):
                    extra.decompose()
                for img in node.select('img'):
                    url=img.get('src',''); data=None
                    if url.startswith('data:image/'): data=base64.b64decode(url.split(',')[1])
                    elif url in files: data=files[url].read_bytes()
                    if not data:
                        warnings.append({'field':field,'reason':'原图未取得，无法识别','source':url})
                        img.replace_with('【原图缺失，待核对】'); continue
                    key=hashlib.sha256(data).hexdigest()
                    if key not in images:
                        im=Image.open(BytesIO(data)).convert('RGBA')
                        white=Image.new('RGBA',im.size,'white');white.alpha_composite(im)
                        rgb=white.convert('RGB')
                        box=ImageChops.difference(rgb,Image.new('RGB',rgb.size,'white')).getbbox()
                        if box: rgb=ImageOps.expand(rgb.crop(box),border=12,fill='white')
                        if rgb.height<100: rgb=rgb.resize((rgb.width*2,rgb.height*2))
                        target=BytesIO();rgb.save(target,format='PNG')
                        images[key]={'id':key,'image':'data:image/png;base64,'+base64.b64encode(target.getvalue()).decode(),
                                     'original':'data:image/png;base64,'+base64.b64encode(data).decode(),'contexts':[]}
                    if len(images[key]['contexts'])<2:
                        images[key]['contexts'].append({'field':field,'question':original['stem'][:1600]})
                    img.replace_with('[[image:'+key+']]')
                for br in node.select('br'): br.replace_with('\n')
                for el in node.select('p,div,tr'): el.append('\n')
                return re.sub(r'[ \t]+',' ',node.get_text(' ',strip=True)).strip()
            stem=soup.select_one('.topic-content')
            options=[]
            if stem:
                for td in list(stem.select('td')):
                    if re.match(r'^\s*[A-H][.．、]',td.get_text()):
                        label=td.get_text().strip()[0]
                        options.append({'label':label,'text':re.sub(r'^[A-H][.．、]\s*','',part(td,'option_'+label))})
                        td.decompose()
            blocks=soup.select('.ans-analy .ana_list')
            answer=next((b for b in blocks if b.select_one('.answer') or '【答案】' in b.get_text()),None)
            analysis=next((b for b in blocks if '【解析】' in b.get_text()),None)
            questions.append({'source_id':row['source_id'],'batch':name,'number':row['number'],
                'stem':part(stem,'stem'),'options':options,'answer':part(answer,'answer'),'analysis':part(analysis,'analysis'),
                'warnings':warnings,'original_warnings':original.get('warnings',[])})
    output.mkdir(parents=True,exist_ok=True)
    (output/'prepared.json').write_text(json.dumps({'images':list(images.values()),'questions':questions},ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'questions':len(questions),'unique_images':len(images),'missing_references':sum(len(q['warnings']) for q in questions)}))

if __name__=='__main__': prepare(Path(sys.argv[1]),Path(sys.argv[2]))
