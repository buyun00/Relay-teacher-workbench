import { useEffect, useRef, useState } from "react";
import { Archive, ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, Copy, LoaderCircle, MessageSquare, Paperclip, Sparkles, Square } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { bridge } from "./bridge";
import { ModelPicker } from "./ModelPicker";
import { ChatAttachments } from "./ChatAttachments";
import type { ChatEvent, ChatTurn, ChatView, LocalTask, Snapshot } from "./types";

const active = (t?: ChatTurn) => !!t && ["queued", "running", "cancelling"].includes(t.state);
const toolLabels: Record<string, string> = {
  teacher_context: "查看教师资料", teacher_read: "读取资料", teacher_query: "检索与统计",
  teacher_import: "导入资料", teacher_artifact: "处理报告与备课", teacher_record: "保存教学记录",
  teacher_correct: "保存更正", teacher_job: "跟进处理任务", teacher_courseware: "制作课件",
  read_file: "读取文件", vision_analyze: "读取图片", write_file: "写入文件", patch: "修改文件", terminal: "执行操作",
  web_search: "搜索资料", web_extract: "阅读网页", skill_view: "查看制作工具", todo: "更新任务步骤",
};
type Run = (action: () => Promise<unknown>, success?: string) => Promise<void>;

export function Chat({ task, snapshot: s, run, disabled = false }: { task?: LocalTask; snapshot: Snapshot; run: Run; disabled?: boolean }) {
  const [view, setView] = useState<ChatView | null>(null);
  const [draft, setDraft] = useState(task?.draft || "");
  const [loading, setLoading] = useState(!!task);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scroll = useRef<HTMLDivElement>(null), stick = useRef(true);
  const taskId = task?.id;
  const archived = !!task?.archived_at;
  const selectedId = useRef(taskId);
  selectedId.current = taskId;
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const load = async () => {
    if (!taskId) return;
    setLoading(true); setError("");
    try { const next = await bridge.readChat(taskId); if (selectedId.current === taskId) setView(next); }
    catch (e) { if (selectedId.current === taskId) setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "连接失败"); }
    finally { if (selectedId.current === taskId) setLoading(false); }
  };
  useEffect(() => {
    setView(null); setError(""); stick.current = true;
    let live = true;
    const unsubscribe = bridge.subscribeChat((next) => {
      if (live && next.chat.id === taskId) setView(next);
    });
    if (taskId) {
      setLoading(true);
      void bridge.readChat(taskId).then((next) => { if (live) setView(next); }).catch((e) => {
        if (live) setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "连接失败");
      }).finally(() => { if (live) setLoading(false); });
    }
    return () => { live = false; unsubscribe(); };
  }, [taskId]);
  const tail = view?.turns.at(-1);
  const busy = active(tail);
  const attachments = task?.attachments || [];
  useEffect(() => {
    if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [view?.cursor, loading, taskId]);
  const add = async (files?: File[]) => {
    if (!taskId || archived || disabled || sending || adding) return;
    setAdding(true);
    try { await run(() => files ? bridge.importChatFiles({ id: taskId, files }) : bridge.selectChatFiles(taskId)); }
    finally { setAdding(false); }
  };
  const send = async (retry?: ChatTurn) => {
    const content = retry?.content ?? draft;
    const ids = (retry?.attachments ?? attachments).map(a => a.id);
    if (!taskId || (!content.trim() && !ids.length) || busy || sending || adding || disabled || archived || loading) return;
    setSending(true);
    stick.current = true;
    try {
      await run(async () => {
        await bridge.sendChat({ id: taskId, content, attachments: ids });
        if (selectedId.current === taskId && currentDraft.current === content) setDraft("");
        // The selected stream carries the accepted turn; refresh also covers a slow initial connection.
        if (selectedId.current === taskId && (!view || view.connection === "offline")) await load();
      });
    } finally { setSending(false); }
  };
  return <div className="chat-view" onDragOver={e => {
    if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = archived || !task ? "none" : "copy"; setDragging(true); }
  }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => {
    e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void add(Array.from(e.dataTransfer.files));
  }}>
    <header className="pane-header chat-header">
      <h1>{task?.title || "新任务"}</h1>
      {archived && <span className="archive-badge"><Archive size={12} />已归档</span>}
      {task && <ModelPicker key={task.id} models={s.chatModels} value={view?.chat.model_id || "auto"}
          disabled={disabled || busy || sending || loading || archived}
          onChange={(modelId) => { const id = task.id; void run(async () => {
            const next = await bridge.selectChatModel({ id, modelId });
            if (selectedId.current === id) setView(next);
          }); }} />}
    </header>
    {view?.chat.route_reason && <div className="route-note" role="status">
      {view.chat.route_state === "locked" ? <Check size={13} /> : <MessageSquare size={13} />}
      <span title={view.chat.route_reason}>{view.chat.route_reason.slice(0, 70)}{view.chat.route_reason.length > 70 && "…"}{view.chat.route_state === "locked" && " · 已固定到这段对话"}</span>
    </div>}
    <div className={"conversation " + (!view?.turns.length ? "is-empty" : "")} ref={scroll} onScroll={() => {
      const el = scroll.current;
      if (el) { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; setAtBottom(stick.current); }
    }}>
      {!view?.turns.length && <div className="conversation-empty">
        <div className="welcome-orb">{loading ? <LoaderCircle size={30} className="spin" /> : <Sparkles size={30} strokeWidth={1.5} />}</div>
        <h2>{loading ? "正在打开对话" : "今天想完成什么？"}</h2>
        <p>{archived ? "这段对话已归档，恢复后可以继续。" : "说说你的想法，我们一起把它做出来。"}</p>
      </div>}
      {error && <div className="chat-error" role="alert">{error}<button className="text-button" onClick={() => void load()}>重试连接</button></div>}
      {!!view?.turns.length && <div className="message-list">
        {view?.turns.map((turn) => <article className="chat-turn" key={turn.id}>
          <div className="user-message"><div>{turn.content && <div>{turn.content}</div>}
            {!!turn.attachments?.length && <ChatAttachments chatId={view.chat.id} files={turn.attachments} run={run} />}</div></div>
          <div className="assistant-message">
            <Steps events={view.events.filter((e) => e.turn_id === turn.id)} busy={active(turn)} />
            {turn.answer && <div className="markdown-body" aria-label="AI 回复"><Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
              a: ({ href, children }) => <a href={href} onClick={(e) => { e.preventDefault(); if (href && /^https?:\/\//.test(href)) void run(() => bridge.openLink(href)); }}>{children}</a>,
            }}>{turn.answer}</Markdown></div>}
            {active(turn) && <div className="reply-progress" role="status"><LoaderCircle size={13} className="spin" />
              {turn.state === "cancelling" ? "正在停止…" : turn.state === "queued" ? "等待开始…" : [...view.events].reverse().find((e) => e.turn_id === turn.id && e.kind === "status")?.payload.text || "正在回复…"}
            </div>}
            {!active(turn) && <div className="reply-footer">
              {turn.state === "cancelled" && <span>已停止</span>}
              {turn.state === "interrupted" && <span>回复已中断</span>}
              {turn.error && <span className="chat-error-text">{turn.error}</span>}
              {["failed", "interrupted"].includes(turn.state) && <button className="text-button" disabled={busy || sending || adding} onClick={() => void send(turn)}>重新发送</button>}
              {turn.answer && <CopyText text={turn.answer} />}
              {turn.model_id && <small>{s.chatModels.find((m) => m.id === turn.model_id)?.label || turn.model_id}</small>}
            </div>}
          </div>
        </article>)}
      </div>}
    </div>
    {view?.connectionError && <div className="chat-connection" role="status">{view.connectionError}</div>}
    {!atBottom && <button className="latest-button" aria-label="回到最新消息" onClick={() => {
      stick.current = true; setAtBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
    }}><ArrowDown size={16} /></button>}
    <div className="composer-area">
      <div className={"composer " + (dragging ? "is-dragging" : "")}>
        {!!attachments.length && task && <ChatAttachments chatId={task.id} files={attachments} run={run} removable disabled={sending || adding || archived} />}
        <textarea aria-label="消息草稿" autoFocus value={draft} disabled={!task || disabled || archived}
          placeholder={archived ? "恢复对话后继续聊天" : task ? "发消息，说说你想做什么…" : "新建一个任务，开始聊天"}
          onChange={(e) => { const value = e.target.value; setDraft(value); if (task) void run(() => bridge.saveTaskDraft({ id: task.id, draft: value })); }}
          onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); void add(Array.from(e.clipboardData.files)); } }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); } }} />
        <div className="composer-bottom"><button className="attach-button" aria-label="添加附件" title="添加文件或图片，也可拖入文件、粘贴图片" disabled={!task || disabled || archived || sending || adding} onClick={() => void add()}>
          {adding ? <LoaderCircle size={17} className="spin" /> : <Paperclip size={17} />}</button>
          <small>{sending ? "正在发送消息及附件…" : adding ? "正在保存附件…" : s.mode === "preview" ? "浏览器演示使用虚构回复" : "Enter 发送 · 可拖入文件、粘贴图片"}</small>
          {busy ? <button className="send-button" aria-label="停止回复" disabled={tail?.state === "cancelling"} onClick={() => void run(() => bridge.cancelChat(task!.id))}><Square size={12} fill="currentColor" /></button>
            : <button className="send-button" aria-label="发送消息" disabled={disabled || archived || !task || (!draft.trim() && !attachments.length) || sending || adding || loading} onClick={() => void send()}>
              {sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}
            </button>}
        </div>
      </div>
      {task && (draft || attachments.length > 0) && <span className="draft-note">{task.draft === draft ? "草稿已保存在本机" : "正在保存草稿…"}</span>}
    </div>
    {dragging && task && !archived && <div className="attachment-drop-hint"><Paperclip size={24} />松开即可添加到这条消息</div>}
  </div>;
}

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="icon-button" aria-label="复制回复" onClick={() => {
    void bridge.copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => setCopied(false));
  }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>;
}

function Steps({ events, busy }: { events: ChatEvent[]; busy: boolean }) {
  const starts = events.filter((e) => e.kind === "tool_start");
  if (!starts.length && !events.some((e) => e.kind === "notice")) return null;
  const ends = events.filter((e) => e.kind === "tool_end");
  const complete = starts.filter((s) => ends.some((e) => e.payload.id === s.payload.id)).length;
  return <details className="tool-steps" open={busy}>
    <summary><span>执行步骤 · {complete}/{starts.length}</span><ChevronDown size={13} /></summary>
    {events.filter((e) => e.kind === "notice").map((e) => <p className="tool-notice" key={e.seq}>{e.payload.text}</p>)}
    {starts.map((step) => {
      const end = ends.find((e) => e.payload.id === step.payload.id);
      const failed = end?.payload.failed;
      return <details className={"tool-step " + (failed ? "failed" : "")} key={step.seq}>
        <summary>{end ? failed ? <CircleAlert size={13} /> : <Check size={13} /> : busy ? <LoaderCircle size={13} className="spin" /> : <Square size={11} />}
          <span>{toolLabels[step.payload.name || ""] || step.payload.name}</span>
          <small>{end ? failed ? "执行失败" : "已执行" : busy ? "进行中" : "未完成"}</small><ChevronDown size={12} />
        </summary>
        <code>{step.payload.name}</code><pre>{JSON.stringify(step.payload.args, null, 2)}</pre>
        {end?.payload.result && <pre>{end.payload.result}</pre>}
      </details>;
    })}
  </details>;
}
