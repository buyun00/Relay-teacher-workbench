import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  CheckCheck,
  FileAudio2,
  MessageSquare,
  Mic,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { bridge } from "./bridge";
import { StudentPicker } from "./StudentPicker";
import type {
  OrganizationData,
  OrganizationEvent,
  RecordingActivity,
  ScheduleEntry,
  Snapshot,
} from "./types";
import "./recording.css";

type Page = "uploads" | "review" | "history" | "schedule";
const time = (value: string | null) => value?.slice(11, 16) || "时间待确认";
const day = (a: RecordingActivity) =>
  a.started_at?.slice(0, 10) || "日期待确认";
const pending = (a: RecordingActivity) =>
  a.events.filter((e) => e.resolution === "pending").length;
const dateLabel = (d: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? new Date(d + "T12:00:00").toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      })
    : d;
const stateLabel = (state: string) =>
  ({
    queued: "等待上传",
    uploading: "正在上传",
    received: "已上传",
    awaiting_lesson: "等待活动识别",
    retry: "等待重试",
    attention: "上传失败",
    missing: "本地副本缺失",
    transcribing: "语音转写中",
    transcribed: "转写已保存",
    analyzing: "活动识别中",
    analyzed: "待整理",
    needs_attention: "处理需检查",
    stale: "来源已更新",
  })[state] || state;

export function RecordingWorkspace({
  snapshot: s,
  page,
  navigate,
  uploadButton,
  openSettings,
  run,
}: {
  snapshot: Snapshot;
  page: Page;
  navigate: (p: Page) => void;
  uploadButton: ReactNode;
  openSettings: () => void;
  run: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const [data, setData] = useState<OrganizationData | null>(null),
    [error, setError] = useState("");
  const [selected, setSelected] = useState(""),
    [node, setNode] = useState(""),
    [all, setAll] = useState(false),
    [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleEntry[] | null>(
    null,
  );
  async function refresh() {
    try {
      const result = await bridge.organization();
      setData(result);
      setError("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )
          : "读取整理记录失败",
      );
    }
  }
  useEffect(() => {
    if (busy) return;
    let live = true;
    const read = async () => {
      try {
        const result = await bridge.organization();
        if (live) {
          setData(result);
          setError("");
        }
      } catch (err) {
        if (live)
          setError(err instanceof Error ? err.message : "读取整理记录失败");
      }
    };
    void read();
    const timer = setInterval(() => {
      if (!busy) void read();
    }, 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [s.config.endpoint, s.config.workspaceId, busy]);
  const activities = [...(data?.activities || [])].sort((a, b) =>
    (a.started_at || "").localeCompare(b.started_at || ""),
  );
  const activity =
    activities.find((a) => a.id === selected) ||
    activities.find((a) => a.status === "draft") ||
    activities.at(-1);
  const currentNode =
    activity?.events.find((e) => e.id === node) ||
    activity?.events.find((e) => e.resolution === "pending") ||
    activity?.events[0];
  const className = (a: RecordingActivity) =>
    data?.classes.find((c) => c.id === a.class_id)?.name || "班级待确认";
  async function command(
    action: string,
    extra: Record<string, unknown> = {},
    success?: string,
  ) {
    if (busy) return;
    setBusy(true);
    let saved = false;
    try {
      await run(async () => {
        await bridge.organize({
          action,
          id: activity?.id,
          revision: activity?.revision,
          ...extra,
        });
        const result = await bridge.organization();
        setData(result);
        setError("");
        saved = true;
        if (action === "note" && currentNode)
          setNotes((n) => ({ ...n, [currentNode.id]: "" }));
      }, success);
    } finally {
      setBusy(false);
    }
    return saved;
  }
  const openActivity = (a: RecordingActivity) => {
    setSelected(a.id);
    setNode("");
    setAll(false);
    navigate("review");
  };
  const days = [
    ...new Set(activities.filter((a) => a.status === "saved").map(day)),
  ]
    .sort()
    .reverse();
  const renderCard = (e: OrganizationEvent) => (
    <article
      className={"org-question " + (currentNode?.id === e.id ? "active" : "")}
      key={e.id}
    >
      <div className="org-question-time">
        <span>
          {e.at
            ? "约 " + time(e.at)
            : "录音内约 " + Math.floor(e.offset / 60) + " 分钟"}
        </span>
        <small>
          {activity?.started_at && e.at
            ? `本时段第 ${Math.max(1, Math.round((Date.parse(e.at) - Date.parse(activity.started_at)) / 60000))} 分钟`
            : "录制时间尚未确认"}
        </small>
        <span className="org-tag">
          {e.resolution === "pending"
            ? "需要确认"
            : e.resolution === "unknown"
              ? "保留未知"
              : "已保存"}
        </span>
      </div>
      <h3>{e.title}</h3>
      <p className="org-muted">{e.detail}</p>
      <div className="org-context-quotes">
        {e.context.map((c) => (
          <div key={c.id} className={c.target ? "target" : ""}>
            <small>
              {Math.floor(c.start / 60)
                .toString()
                .padStart(2, "0")}
              :
              {Math.floor(c.start % 60)
                .toString()
                .padStart(2, "0")}{" "}
              · {c.target ? "待核对原句" : "相邻原文"}
            </small>
            <p>{c.text}</p>
          </div>
        ))}
      </div>
      {e.question && <strong className="org-ask">{e.question}</strong>}
      <div className="org-question-actions">
        <button className="text-button" onClick={() => setNode(e.id)}>
          <MessageSquare size={14} />
          {currentNode?.id === e.id ? "已加入右侧对话" : "加入右侧对话"}
          <ArrowRight size={13} />
        </button>
        <StudentPicker
          data={data!}
          classId={activity?.class_id || null}
          value={e.student_id}
          role={e.role}
          disabled={busy || activity?.stale}
          onSelect={(student_id, role) =>
            void command("resolve", { event_id: e.id, student_id, role })
          }
        />
        {e.resolution === "pending" && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void command("resolve", {
                event_id: e.id,
                student_id: null,
                role: "unknown",
              })
            }
          >
            记不清
          </button>
        )}
      </div>
      {e.note && <p className="org-saved-note">教师补充：{e.note}</p>}
    </article>
  );
  return (
    <div className="org-workspace">
      <header className="org-header">
        <div>
          {page === "review" && (
            <button className="text-button" onClick={() => navigate("uploads")}>
              <ArrowLeft size={13} />
              返回上传与分析
            </button>
          )}
          <h1>
            {
              {
                uploads: "上传与自动分析",
                review: "录音数据整理",
                history: "课程历史",
                schedule: "我的课表",
              }[page]
            }
          </h1>
          <p>
            {
              {
                uploads: "把一天的录音，整理成值得留下的记录。",
                review: "只确认有疑问的内容，清楚的记录会一并保存。",
                history: "按日期和课次保存，后续对话可以直接使用这些记录。",
                schedule: "按录制日期和时间预选班级，临时调课仍可手动修改。",
              }[page]
            }
          </p>
        </div>
        <div className="org-header-actions">
          <button
            className="button secondary"
            aria-label="刷新整理记录"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
          </button>
          {page === "uploads" && (
            <>
              {uploadButton}
              <button
                className="button secondary"
                onClick={() => navigate("schedule")}
              >
                <CalendarDays size={15} />
                课表
              </button>
            </>
          )}
          {page === "review" && activity && (
            <span className="org-tag">本时段 {pending(activity)} 项待确认</span>
          )}
        </div>
      </header>
      {error && (
        <div className="org-error" role="alert">
          {error}
          <button className="text-button" onClick={() => void refresh()}>
            重试
          </button>
          {!s.config.endpoint && s.mode !== "preview" && (
            <button className="text-button" onClick={openSettings}>
              设置连接
            </button>
          )}
        </div>
      )}
      {page === "uploads" && (
        <div className="org-upload-scroll">
          <div className="org-steps">
            <b>1 上传与分析</b>
            <span>2 数据整理</span>
            <span>3 确认入库</span>
          </div>
          <div className="org-upload-grid">
            <section className="org-glass org-queue">
              <h2>导入与处理</h2>
              <p className="org-muted">本机共 {s.files.length} 份录音</p>
              <div className="org-device">
                <Mic size={23} />
                <div>
                  <b>
                    {s.devices.some((d) => d.connected)
                      ? "录音设备已连接"
                      : "等待录音设备"}
                  </b>
                  <small>
                    {s.copying
                      ? "正在保存本地副本，请保持连接"
                      : s.devices.some((d) => d.connected && d.safeToUnplug)
                        ? "本地已保存，可以拔出设备"
                        : "可选择目录或手动导入录音"}
                  </small>
                </div>
              </div>
              <button
                className="text-button"
                disabled={s.scanning || !!s.copying}
                onClick={() => void run(() => bridge.selectFolder())}
              >
                选择录音目录
              </button>
              <Progress
                label="上传进度"
                done={s.files.filter((f) => f.state === "received").length}
                total={s.files.length}
                percent={
                  s.files.length
                    ? (s.files.reduce(
                        (n, f) =>
                          n +
                          (f.state === "received" ? f.bytes : f.uploadedBytes),
                        0,
                      ) /
                        Math.max(
                          1,
                          s.files.reduce((n, f) => n + f.bytes, 0),
                        )) *
                      100
                    : 0
                }
              />
              <Progress
                label="转写与活动识别"
                done={
                  s.files.filter((f) => f.remote?.workflow?.complete).length
                }
                total={s.files.length}
                percent={
                  (s.files.filter((f) => f.remote?.workflow?.complete).length /
                    Math.max(1, s.files.length)) *
                  100
                }
              />
              <div className="org-inline">
                <small>
                  {activities.filter((a) => a.status === "draft").length}{" "}
                  段待整理
                </small>
                <button
                  className="text-button"
                  onClick={() =>
                    void run(() => bridge.pause(!s.config.pauseUploads))
                  }
                >
                  {s.config.pauseUploads ? (
                    <Play size={12} />
                  ) : (
                    <Pause size={12} />
                  )}{" "}
                  {s.config.pauseUploads ? "继续上传" : "暂停上传"}
                </button>
              </div>
              <div className="org-file-heading">
                <b>文件处理明细</b>
                <small>上传与处理同时进行</small>
              </div>
              {s.files.map((f) => (
                <div className="org-file" key={f.id}>
                  <FileAudio2 size={17} />
                  <div>
                    <b>{f.filename}</b>
                    <small>{(f.bytes / 1e6).toFixed(1)} MB</small>
                    {(f.error || f.remote?.workflow?.error) && (
                      <p className="file-error">
                        {f.error || f.remote?.workflow?.error}
                      </p>
                    )}
                  </div>
                  <span>
                    {stateLabel(
                      f.state === "received"
                        ? f.remote?.state || "received"
                        : f.state,
                    )}
                  </span>
                  {["retry", "attention", "missing"].includes(f.state) && (
                    <button
                      className="text-button"
                      onClick={() => void run(() => bridge.retry(f.id))}
                    >
                      重试
                    </button>
                  )}
                </div>
              ))}
              {!s.files.length && (
                <p className="org-muted">
                  插入设备或手动导入，录音会先保存到本机。
                </p>
              )}
            </section>
            <section className="org-glass org-activities">
              <div className="org-inline">
                <div>
                  <h2>初步整理出的活动</h2>
                  <p className="org-muted">
                    按时间与内容预分类，统一进入整理流程
                  </p>
                </div>
                <BookOpen size={20} />
              </div>
              {activities.length > 0 && (
                <button
                  className="button primary org-start"
                  onClick={() =>
                    openActivity(
                      activities.find((a) => a.status === "draft") ||
                        activities[0],
                    )
                  }
                >
                  开始整理录音 <ArrowRight size={15} />
                </button>
              )}
              {[...activities].reverse().map((a) => (
                <article className={"org-activity " + a.kind} key={a.id}>
                  <div className="org-inline">
                    <span>
                      {a.kind === "class"
                        ? "课堂教学"
                        : a.kind === "conversation"
                          ? "个别谈话"
                          : "其他活动"}
                    </span>
                    <span className="org-tag">
                      {a.stale
                        ? "来源已更新"
                        : a.status === "saved"
                          ? "已入库"
                          : `${pending(a)} 项待确认`}
                    </span>
                  </div>
                  <h3>
                    {a.period && <small>{a.period} </small>}
                    {a.title}
                  </h3>
                  <p>
                    {dateLabel(day(a))} · {time(a.started_at)}—
                    {time(a.ended_at)}
                  </p>
                  <p>
                    {className(a)}
                    {a.class_source === "schedule" ? " · 课表匹配" : ""}
                  </p>
                  <small>
                    <FileAudio2 size={13} /> 涉及 {a.asset_ids.length} 份录音
                  </small>
                </article>
              ))}
              {!activities.length && (
                <div className="org-empty">
                  <UploadCloud size={30} />
                  <h3>
                    {data ? "活动分析完成后会出现在这里" : "正在连接资料库"}
                  </h3>
                  <p>
                    每半小时的录音文件可以合并为同一节课，也可以拆成不同活动。
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
      {page === "review" && activity && data && (
        <>
          <div className="org-day">
            <CalendarDays size={15} />
            {dateLabel(day(activity))}
            <small>当天时段 · 初步分类</small>
          </div>
          <nav className="org-periods" aria-label="当天活动">
            {activities
              .filter((a) => day(a) === day(activity))
              .map((a) => (
                <button
                  key={a.id}
                  className={activity.id === a.id ? "selected" : ""}
                  onClick={() => openActivity(a)}
                >
                  <div>
                    <b>
                      {a.period ||
                        (a.kind === "conversation" ? "个别谈话" : "其他时段")}
                    </b>
                    <small>
                      {a.status === "saved"
                        ? "已入库"
                        : `${pending(a)} 项待确认`}
                    </small>
                  </div>
                  <span>{a.title}</span>
                  <small>
                    {time(a.started_at)}—{time(a.ended_at)}
                  </small>
                </button>
              ))}
          </nav>
          <div className="org-selected">
            <b>
              {activity.period} · {activity.title}
            </b>
            <label>
              班级{" "}
              <select
                aria-label="选择班级"
                disabled={busy || activity.stale}
                value={activity.class_id || ""}
                onChange={(e) =>
                  void command("class", { class_id: e.target.value || null })
                }
              >
                <option value="">未知 / 不关联班级</option>
                {data.classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <small>
              {activity.class_source === "schedule"
                ? "已根据课表匹配，可修改"
                : activity.class_source === "manual"
                  ? "教师指定"
                  : "未匹配课表"}
            </small>
            <span>{activity.asset_ids.length} 份录音</span>
          </div>
          {activity.stale && (
            <p className="org-error">
              原转写已更新，旧记录不可继续确认，请重新分析。
            </p>
          )}
          <div className="org-review-grid">
            <section className="org-questions">
              <div className="org-inline">
                <h2>{all ? "本时段全部记录" : "需要你确认"}</h2>
                <button className="text-button" onClick={() => setAll(!all)}>
                  {all ? "只看待确认" : "查看全部记录"}
                </button>
              </div>
              <div className="org-question-scroll">
                {(all
                  ? activity.events
                  : activity.events
                      .filter((e) => e.resolution === "pending")
                      .slice(0, 3)
                ).map(renderCard)}
                {!all && !pending(activity) && (
                  <div className="org-empty">
                    <CheckCheck size={32} />
                    <h3>本时段已整理好</h3>
                    <p>明确的内容和你补充的信息会一起保存。</p>
                    <button
                      className="text-button"
                      onClick={() => setAll(true)}
                    >
                      查看全部记录
                    </button>
                  </div>
                )}
                {!all && pending(activity) > 3 && (
                  <p className="org-muted">
                    先确认这 3 项，其他 {pending(activity) - 3} 项会接着显示。
                  </p>
                )}
              </div>
            </section>
            <aside className="org-conversation">
              <h2>
                <MessageSquare size={19} />
                补充与澄清
              </h2>
              <p className="org-muted">只围绕当前片段补全和纠正记录</p>
              <div className="org-note-scroll">
                {currentNode?.question && (
                  <div className="org-message">
                    <small>待确认问题 · {time(currentNode.at)}</small>
                    <p>{currentNode.question}</p>
                  </div>
                )}
                {activity.notes
                  .filter((n) => n.event_id === currentNode?.id)
                  .map((n, i) => (
                    <div className="org-message teacher" key={i}>
                      <small>教师补充 · 已保存</small>
                      <p>{n.text}</p>
                    </div>
                  ))}
              </div>
              {currentNode && (
                <form
                  className="org-composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void command(
                      "note",
                      {
                        event_id: currentNode.id,
                        text: notes[currentNode.id] || "",
                      },
                      "补充已保存",
                    );
                  }}
                >
                  <div className="org-reference">
                    <small>
                      引用 · {time(currentNode.at)} · {currentNode.title}
                    </small>
                    <p>
                      {currentNode.context.find((c) => c.target)?.text ||
                        currentNode.detail}
                    </p>
                  </div>
                  <textarea
                    aria-label="教师补充"
                    placeholder="补充当时的情况，或纠正这段记录…"
                    value={notes[currentNode.id] || ""}
                    onChange={(e) =>
                      setNotes((n) => ({
                        ...n,
                        [currentNode.id]: e.target.value,
                      }))
                    }
                  />
                  <button
                    className="button primary"
                    disabled={
                      busy || activity.stale || !notes[currentNode.id]?.trim()
                    }
                  >
                    <Save size={14} />
                    保存补充
                  </button>
                </form>
              )}
            </aside>
          </div>
          <footer className="org-review-footer">
            <small>
              <CheckCheck size={15} />
              {activity.status === "saved"
                ? "已入库；更正会同步更新历史记录"
                : "整理进度已保存；确认后加入课程历史"}
            </small>
            <button
              className="button secondary"
              onClick={() => navigate("uploads")}
            >
              稍后继续
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                activity.stale ||
                pending(activity) > 0 ||
                activity.status === "saved"
              }
              onClick={() =>
                void command("publish", {}, "此时段已入库，后续对话可使用记录")
              }
            >
              <Check size={16} />
              {activity.status === "saved" ? "已入库" : "完成此时段并入库"}
            </button>
          </footer>
        </>
      )}
      {page === "review" && !activity && (
        <div className="org-empty">
          还没有可整理的活动。
          <button className="text-button" onClick={() => navigate("uploads")}>
            返回上传
          </button>
        </div>
      )}
      {page === "history" && (
        <div className="org-history-scroll">
          {days.map((d) => (
            <section className="org-history-day" key={d}>
              <h2>
                <CalendarDays size={18} />
                {dateLabel(d)}
              </h2>
              <div className="org-history-line">
                {activities
                  .filter((a) => a.status === "saved" && day(a) === d)
                  .map((a) => (
                    <article key={a.id}>
                      <div className="org-history-time">
                        <b>
                          {a.period ||
                            (a.kind === "class" ? "临时课程" : "个别谈话")}
                        </b>
                        <span>
                          {time(a.started_at)}—{time(a.ended_at)}
                        </span>
                      </div>
                      <div className="org-history-card">
                        <div>
                          <small>
                            {className(a)} ·{" "}
                            {a.kind === "class" ? "课堂记录" : "活动记录"}
                          </small>
                          <h3>{a.title}</h3>
                          <p>
                            {dateLabel(d)} · 当天 {time(a.started_at)}{" "}
                            开始的时段
                          </p>
                          <small>
                            {a.asset_ids.length} 份录音 · {a.events.length}{" "}
                            条记录{a.stale ? " · 来源已更新" : ""}
                          </small>
                        </div>
                        <button
                          className="button secondary"
                          onClick={() => openActivity(a)}
                        >
                          查看记录
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    </article>
                  ))}
              </div>
            </section>
          ))}
          {!days.length && (
            <div className="org-empty">
              <BookOpen size={30} />
              <h3>还没有确认入库的记录</h3>
              <p>整理完成的每节课会按日期排列在这里。</p>
            </div>
          )}
        </div>
      )}
      {page === "schedule" && data && (
        <div className="org-schedule-scroll">
          <div className="org-inline">
            <h2>每周课表</h2>
            <button
              className="button secondary"
              disabled={!data.classes.length}
              onClick={() =>
                setScheduleDraft([
                  ...(scheduleDraft || data.schedule),
                  {
                    weekday: 1,
                    start: "08:10",
                    end: "08:50",
                    period: "第一节课",
                    class_id: data.classes[0]?.id || "",
                  },
                ])
              }
            >
              <Plus size={15} />
              添加课程
            </button>
          </div>
          {!data.classes.length && (
            <p>暂无班级名单。可在对话中导入班级名册后设置课表。</p>
          )}
          {(scheduleDraft || data.schedule).map((entry, index) => (
            <div className="org-schedule-row" key={index}>
              {(
                [
                  [
                    "weekday",
                    "星期",
                    <select
                      value={entry.weekday}
                      onChange={(e) => {
                        const rows = structuredClone(
                          scheduleDraft || data.schedule,
                        );
                        rows[index].weekday = Number(e.target.value);
                        setScheduleDraft(rows);
                      }}
                    >
                      {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                        <option key={n} value={n}>
                          星期{"一二三四五六日"[n - 1]}
                        </option>
                      ))}
                    </select>,
                  ],
                  [
                    "period",
                    "课次",
                    <input
                      value={entry.period}
                      onChange={(e) => {
                        const rows = structuredClone(
                          scheduleDraft || data.schedule,
                        );
                        rows[index].period = e.target.value;
                        setScheduleDraft(rows);
                      }}
                    />,
                  ],
                  [
                    "start",
                    "开始",
                    <input
                      type="time"
                      value={entry.start}
                      onChange={(e) => {
                        const rows = structuredClone(
                          scheduleDraft || data.schedule,
                        );
                        rows[index].start = e.target.value;
                        setScheduleDraft(rows);
                      }}
                    />,
                  ],
                  [
                    "end",
                    "结束",
                    <input
                      type="time"
                      value={entry.end}
                      onChange={(e) => {
                        const rows = structuredClone(
                          scheduleDraft || data.schedule,
                        );
                        rows[index].end = e.target.value;
                        setScheduleDraft(rows);
                      }}
                    />,
                  ],
                  [
                    "class",
                    "班级",
                    <select
                      value={entry.class_id}
                      onChange={(e) => {
                        const rows = structuredClone(
                          scheduleDraft || data.schedule,
                        );
                        rows[index].class_id = e.target.value;
                        setScheduleDraft(rows);
                      }}
                    >
                      {data.classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>,
                  ],
                ] as [string, string, ReactNode][]
              ).map(([key, label, control]) => (
                <label key={key}>
                  {label}
                  {control}
                </label>
              ))}
              <button
                className="icon-button"
                aria-label={`删除第${index + 1}条课表`}
                onClick={() =>
                  setScheduleDraft(
                    (scheduleDraft || data.schedule).filter(
                      (_, i) => i !== index,
                    ),
                  )
                }
              >
                <X size={16} />
              </button>
            </div>
          ))}
          <button
            className="button primary"
            disabled={busy || !scheduleDraft}
            onClick={() =>
              void command(
                "schedule",
                {
                  entries: scheduleDraft,
                  revision: data.schedule_revision || 0,
                },
                "课表已保存",
              ).then((saved) => {
                if (saved) setScheduleDraft(null);
              })
            }
          >
            <Save size={16} />
            保存课表
          </button>
        </div>
      )}
    </div>
  );
}
function Progress({
  label,
  done,
  total,
  percent,
}: {
  label: string;
  done: number;
  total: number;
  percent: number;
}) {
  return (
    <div className="org-progress">
      <div>
        <span>{label}</span>
        <small>
          {done} / {total} 份完成
        </small>
      </div>
      <div
        className="org-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i style={{ width: Math.max(0, Math.min(100, percent)) + "%" }} />
      </div>
    </div>
  );
}
