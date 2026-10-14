// Fictional, browser-only demonstration. Electron always calls the server.
export function questionPreview() {
  const items: any[] = [{id:'fictional-question',revision:1,body:{format:'latex',options:[{label:'A',text:'充分而不必要条件'},{label:'B',text:'必要而不充分条件'}],answer_check:{status:'consistent',reason:'虚构机器核对：两个方向的推导已比较',suggested_answer:'A',solution:'虚构示例中正向成立，反向有反例。'},stem:'虚构示例：x = 1 是 x² = 1 的什么条件？',stem_html:'<p>虚构示例：<math><mi>x</mi><mo>=</mo><mn>1</mn></math> 是 <math><msup><mi>x</mi><mn>2</mn></msup><mo>=</mo><mn>1</mn></math> 的什么条件？</p>',answer:'充分而不必要条件',analysis:'正向成立；反向可取 x = −1 作为反例。',tags:['充分条件'],kind:'单选题',review_status:'unreviewed'},history:[{revision:1,reason:'虚构预览数据'}]},
    {id:'fictional-missing',revision:1,body:{stem:'虚构示例：根据下图判断函数的单调性（图缺失）。',answer:'待核对',analysis:'待核对',tags:['函数'],kind:'解答题',review_status:'needs_attention',warnings:['missing_image：原图缺失']},history:[]}];
  const papers: any[] = [];
  return async (input: Record<string, any>) => {
    if(input.action==='catalog') return {batches:[{id:'fictional-batch',title:'虚构演示候选',item_count:2}],students:[{id:'fictional-student',name:'虚构学生甲',class_id:'演示班'}],papers,tags:['充分条件','函数'],kinds:['单选题','解答题']};
    if(input.action==='search') {const rows=items.filter(i=>(!input.query||[i.body.stem,i.body.answer,...i.body.tags].join(' ').includes(input.query))&&(!input.review_status||i.body.review_status===input.review_status)&&(!input.kind||i.body.kind===input.kind)&&(!input.tags?.length||input.tags.every((t:string)=>i.body.tags.includes(t))));return {total:rows.length,items:rows.slice(input.offset,input.offset+input.limit).map(i=>({id:i.id,revision:i.revision,...i.body}))};}
    const item=items.find(i=>i.id===input.item_id);
    if(input.action==='read') return structuredClone(item);
    if(input.action==='adapt'||input.action==='revise') {
      if(item.revision!==input.expected_revision) throw Error('题目版本已变化，请重新读取');
      if(input.action==='adapt') {const copy=structuredClone(item);copy.id='fictional-derived-'+items.length;copy.parent_id=item.id;copy.revision=1;copy.body={...copy.body,...input.changes,review_status:'unreviewed',answer_check:{status:'stale',reason:'改编后需重新核对'}};for(const k of ['stem','answer','analysis']) if(k in input.changes) delete copy.body[k+'_html'];copy.history=[{revision:1,reason:input.reason}];items.push(copy);return copy;}
      item.revision++;item.body={...item.body,...input.changes};item.history.push({revision:item.revision,reason:input.reason});return structuredClone(item);
    }
    if(input.action==='compose') {for(const s of input.selections) if(items.find(i=>i.id===s.item_id).revision!==s.revision) throw Error('选题已过期，请重新查找');const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const content=input.selections.map((s:any)=>{const b=items.find(i=>i.id===s.item_id).body;return `<h2>${esc(b.stem)}</h2><p>${esc(s.task.instruction)}</p><p>${esc(s.task.hint)}</p>`;}).join('');const p={id:'fictional-paper-'+papers.length,title:input.title,created_at:'虚构预览',stale:0,student_html:content,teacher_html:content+'<h3>答案解析（教师版）</h3>'+input.selections.map((s:any)=>esc(items.find(i=>i.id===s.item_id).body.answer)).join('<br>')};papers.unshift(p);return p;}
    if(input.action==='preview') return papers.find(p=>p.id===input.paper_id);
    throw Error('浏览器预览不支持此操作');
  };
}
