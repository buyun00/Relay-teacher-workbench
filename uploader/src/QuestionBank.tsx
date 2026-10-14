import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import "./questions.css";

type Row = { id: string; revision: number; stem: string; review_status: string; kind: string; tags: string[] };
type Detail = { id: string; revision: number; parent_id?: string; body: Record<string, any>; history: {revision: number; reason: string}[] };
type Selection = {item_id: string; revision: number; stem: string; task: {instruction: string; hint: string; reason: string}};
const status: Record<string, string> = { unreviewed: "未审核", reviewed: "已审核", needs_attention: "待核对" };
function Frame({content, title}: {content: string; title: string}) {
  return <iframe className="qb-frame" sandbox="" title={title} srcDoc={'<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;;"><style>body{font:16px/1.8 system-ui;color:#25342e;overflow-wrap:anywhere}img{max-width:100%}table{border-collapse:collapse}td{border:1px solid #ddd;padding:5px}math{font-size:1.15em}</style>'+content} />;
}
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function QuestionBank() {
  const [catalog, setCatalog] = useState<any>({batches: [], students: [], papers: [], tags: [], kinds: []});
  const [rows, setRows] = useState<Row[]>([]), [total, setTotal] = useState(0), [offset, setOffset] = useState(0);
  const [query, setQuery] = useState(''), [batch, setBatch] = useState(''), [tag, setTag] = useState(''), [kind, setKind] = useState(''), [review, setReview] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null), [answer, setAnswer] = useState(false);
  const [selected, setSelected] = useState<Selection[]>([]), [tab, setTab] = useState<'bank'|'compose'|'papers'>('bank');
  const [title, setTitle] = useState('个性化练习'), [purpose, setPurpose] = useState(''), [student, setStudent] = useState('');
  const [edit, setEdit] = useState<Record<string, string> | null>(null), [reason, setReason] = useState('');
  const [preview, setPreview] = useState<any>(null), [teacher, setTeacher] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const request = useRef(0), reading = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const call = (input: Record<string, unknown>) => bridge.questionBank(input);
  const refresh = async () => {setCatalog(await call({action: 'catalog'}));setRefreshKey(n=>n+1);};
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch(e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, []);
  useEffect(() => {
    const id = ++request.current; setLoading(true);
    const timer = setTimeout(() => { void call({action:'search',query,batch_id:batch||null,tags:tag?[tag]:[],kind:kind||null,review_status:review||null,offset,limit:20})
      .then(r => { if(id === request.current) {setRows(r.items);setTotal(r.total);setError('');} })
      .catch(e => {if(id===request.current) {setRows([]);setError(String(e));}})
      .finally(() => {if(id===request.current) setLoading(false);}); }, 200);
    return () => { clearTimeout(timer); ++request.current; };
  }, [query,batch,tag,kind,review,offset,refreshKey]);
  const read = async (id: string, revision?: number) => {
    const seq = ++reading.current; setDetail(null); setEdit(null); setAnswer(false);
    const value = await call({action:'read',item_id:id,...(revision?{revision}:{})});
    if(seq===reading.current) setDetail(value);
  };
  const add = (d: Detail) => {
    if(selected.some(s => s.item_id===d.id)) {setNotice('这道题已在选题篮中'); return;}
    setSelected([...selected,{item_id:d.id,revision:d.revision,stem:d.body.stem,task:{instruction:'',hint:'',reason:''}}]); setNotice('已加入选题篮');
  };
  const openPaper = async (id: string) => {setPreview(await call({action:'preview',paper_id:id}));setTeacher(false);};
  return <div className="qb-workspace">
    <header className="qb-header"><div><h1>题库与作业</h1><p>从候选题出发，为每个学生安排练习</p></div><button className="button" disabled={busy} onClick={() => void run(refresh)}>刷新批次</button></header>
    <nav className="qb-tabs" aria-label="题库页面"><button aria-current={tab==='bank'?'page':undefined} onClick={()=>setTab('bank')}>浏览题库</button><button aria-current={tab==='compose'?'page':undefined} onClick={()=>setTab('compose')}>选题篮 · {selected.length}</button><button aria-current={tab==='papers'?'page':undefined} onClick={()=>{setTab('papers');void run(refresh);}}>作业草稿</button></nav>
    {error && <div role="alert" className="qb-error">{error}<button onClick={()=>void run(refresh)}>重试连接</button></div>}
    {notice && <p role="status" className="qb-notice">{notice}</p>}
    {tab==='bank' && <>
      <div className="qb-filters">
        <label>候选批次<select aria-label="候选批次" value={batch} onChange={e=>{setBatch(e.target.value);setOffset(0);setDetail(null);}}><option value="">全部批次与改编题</option>{catalog.batches.map((b:any)=><option key={b.id} value={b.id}>{b.title} · {b.item_count}题</option>)}</select></label>
        <label>搜索<input placeholder="题干、答案或知识点" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0);}} /></label>
        <label>知识点<select aria-label="知识点" value={tag} onChange={e=>{setTag(e.target.value);setOffset(0);}}><option value="">全部知识点</option>{catalog.tags.map((t:string)=><option key={t}>{t}</option>)}</select></label>
        <label>题型<select aria-label="题型" value={kind} onChange={e=>{setKind(e.target.value);setOffset(0);}}><option value="">全部题型</option>{catalog.kinds.map((t:string)=><option key={t}>{t}</option>)}</select></label>
        <label>审核状态<select aria-label="审核状态" value={review} onChange={e=>{setReview(e.target.value);setOffset(0);}}><option value="">全部状态</option>{Object.entries(status).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <div className="qb-columns"><section className="qb-list" aria-label="题目列表"><p>{loading?'正在查询…':`共 ${total} 题`}</p>{!loading&&!rows.length&&<p>没有符合条件的题目。可调整筛选，或让 AI 导入候选题后刷新。</p>}
        {rows.map(r=><button key={r.id} className={detail?.id===r.id?'active':''} disabled={busy} onClick={()=>void run(()=>read(r.id))}><span className={'qb-badge '+r.review_status}>{status[r.review_status]}</span> <small>{r.kind} · v{r.revision}</small><p>{r.stem}</p><small>{r.tags.join(' / ')}</small></button>)}
        <div className="qb-paging"><button disabled={offset===0||loading} onClick={()=>setOffset(Math.max(0,offset-20))}>上一页</button><span>{Math.floor(offset/20)+1} / {Math.max(1,Math.ceil(total/20))}</span><button disabled={offset+20>=total||loading} onClick={()=>setOffset(offset+20)}>下一页</button></div>
      </section><section className="qb-detail" aria-label="题目详情">
        {!detail?<p className="qb-empty">选择一道题，查看原题、解析和修订记录</p>:<>
          <div className="qb-actions"><span className={'qb-badge '+detail.body.review_status}>{status[detail.body.review_status]}</span><span>v{detail.revision}{detail.parent_id?' · 改编题':''}</span><button className="button primary" onClick={()=>add(detail)}>加入选题篮</button></div>
          {!!detail.body.warnings?.length&&<div className="qb-error">此题需要核对：{detail.body.warnings.map((w:any)=>typeof w==='string'?w:JSON.stringify(w)).join('；')}</div>}
          <Frame title="题干预览" content={detail.body.stem_html||'<p>'+escape(detail.body.stem)+'</p>'}/>
          <button className="button" onClick={()=>setAnswer(!answer)}>{answer?'收起答案解析':'查看答案解析'}</button>
          {answer&&<Frame title="答案解析" content={'<h3>答案</h3>'+(detail.body.answer_html||escape(detail.body.answer))+'<h3>解析</h3>'+(detail.body.analysis_html||escape(detail.body.analysis))}/>}
          <div className="qb-actions"><button className="button" disabled={busy} onClick={()=>{setEdit({stem:detail.body.stem,answer:detail.body.answer,analysis:detail.body.analysis});setReason('');}}>改编此题</button><button className="button" disabled={busy} onClick={()=>void run(async()=>{const updated=await call({action:'revise',item_id:detail.id,expected_revision:detail.revision,changes:{review_status:'reviewed'},reason:'教师在题库页面核对题干、题图、答案与解析后确认'});setDetail(updated);setRows(rows.map(r=>r.id===updated.id?{...r,revision:updated.revision,review_status:updated.body.review_status}:r));setNotice('审核已保存；已选旧版本需要重新选入。');})}>确认已核对</button></div>
          {edit&&<form className="qb-edit" onSubmit={e=>{e.preventDefault();void run(async()=>{const changes=Object.fromEntries(Object.entries(edit).filter(([k,v])=>v!==detail.body[k]));const d=await call({action:'adapt',item_id:detail.id,expected_revision:detail.revision,changes,reason});setDetail(d);setEdit(null);setNotice('改编题已保存，原题保留；可加入选题篮。');});}}><h3>另存为改编题</h3><p>只修改需要变动的文字。修改某一部分会用文字替换该部分的原有公式排版或图片，请保存后核对。</p>{[['stem','题干'],['answer','答案'],['analysis','解析']].map(([k,label])=><label key={k}>{label}<textarea aria-label={label} required={k==='stem'} value={edit[k]} onChange={e=>setEdit({...edit,[k]:e.target.value})}/></label>)}<label>改编原因<input aria-label="改编原因" required value={reason} onChange={e=>setReason(e.target.value)}/></label><button className="button primary" disabled={busy}>保存改编题</button><button className="button" type="button" onClick={()=>setEdit(null)}>取消</button></form>}
          <details><summary>修订历史与来源</summary><pre>{JSON.stringify(detail.body.source||{},null,2)}</pre>{detail.history.map(h=><button key={h.revision} disabled={busy} onClick={()=>void run(()=>read(detail.id,h.revision))}>v{h.revision} · {h.reason||'原始导入'}</button>)}</details>
        </>}
      </section></div>
    </>}
    {tab==='compose'&&<form className="qb-compose" onSubmit={e=>{e.preventDefault();void run(async()=>{const paper=await call({action:'compose',title,purpose,student_id:student||null,selections:selected.map(({stem,...s})=>s)});await openPaper(paper.id);await refresh();setSelected([]);setNotice('作业草稿已保存到服务器，尚未布置给学生。');});}}>
      <h2>安排本次练习</h2><div className="qb-filters"><label>作业标题<input required value={title} onChange={e=>setTitle(e.target.value)}/></label><label>学生<select aria-label="学生" value={student} onChange={e=>setStudent(e.target.value)}><option value="">通用草稿（不绑定学生）</option>{catalog.students.map((s:any)=><option key={s.id} value={s.id}>{s.name} · {s.class_id}</option>)}</select></label></div><label>练习目标与安排依据<textarea aria-label="练习目标与安排依据" required placeholder="填写教师确认的目标；不会自动推断学生掌握度" value={purpose} onChange={e=>setPurpose(e.target.value)}/></label>
      {!selected.length&&<p>选题篮是空的，请先在题库中选题。</p>}{selected.map((s,i)=><section key={s.item_id}><h3>第 {i+1} 题 · v{s.revision}<button type="button" onClick={()=>setSelected(selected.filter((_,n)=>n!==i))}>移除</button></h3><p>{s.stem}</p>{[['instruction','学生需要完成什么'],['hint','给学生的提示'],['reason','本题安排依据（仅教师可见）']].map(([k,label])=><label key={k}>{label}<textarea aria-label={label} value={s.task[k as keyof typeof s.task]} onChange={e=>setSelected(selected.map((v,n)=>n===i?{...v,task:{...v.task,[k]:e.target.value}}:v))}/></label>)}</section>)}<button className="button primary" disabled={busy||!selected.length}>{busy?'正在保存…':'生成并保存草稿'}</button>
    </form>}
    {tab==='papers'&&<div className="qb-papers"><h2>最近的作业草稿</h2>{!catalog.papers.length&&<p>还没有作业草稿</p>}{catalog.papers.map((p:any)=><button key={p.id} disabled={busy} onClick={()=>void run(()=>openPaper(p.id))}><strong>{p.title}</strong><span>{p.stale?'依据已更新 · 请重新组卷':'草稿 · 未发布'}</span><small>{p.created_at}</small></button>)}</div>}
    {preview&&<div className="modal-backdrop"><section className="qb-preview" role="dialog" aria-modal="true" aria-label="作业预览"><header><h2>{preview.title}</h2><button onClick={()=>setPreview(null)}>关闭预览</button></header>{!!preview.stale&&<p className="qb-error">依据已更新，此草稿已过期，请重新组卷。</p>}<div className="qb-actions"><button onClick={()=>setTeacher(false)}>学生版</button><button onClick={()=>setTeacher(true)}>教师版</button><button disabled={busy||!!preview.stale} onClick={()=>void run(async()=>{const result=await bridge.saveQuestionPaper({paper_id:preview.id,teacher});if(result.saved)setNotice("作业文件已导出，尚未布置给学生。");})}>导出当前版本</button><span>已保存草稿 · 未发布给学生</span></div><Frame title={teacher?'教师版作业':'学生版作业'} content={teacher?preview.teacher_html:preview.student_html}/></section></div>}
  </div>;
}
