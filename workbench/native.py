from __future__ import annotations

import json
import subprocess
import threading
import os
from pathlib import Path

from .config import Config, WorkbenchError
from .service import Workbench
from .storage import encode
from .delivery_policy import DELIVERY_RULE


def prop(kind, description="", **extra):
    return {"type": kind, **({"description": description} if description else {}), **extra}


REF = prop("object", properties={"kind": prop("string", enum=["segment", "event", "message", "score", "lesson", "exam", "asset"]), "id": prop("string"), "revision": prop("integer")}, required=["kind", "id", "revision"], additionalProperties=False)
SOURCES = prop("array", "只用资料工具返回的当前版本引用", items=REF, maxItems=200)
SCOPE = {"class_id": prop("string"), "student_id": prop("string"), "since": prop("string"), "until": prop("string")}
QUESTION = prop("object", properties={"id": prop("string"), "max_score": prop("number"), "knowledge_point": prop("string"), "mapping_status": prop("string", enum=["unknown", "proposed", "confirmed"])}, required=["id", "max_score"], additionalProperties=False)


def schema(name, description, properties, required=()):
    return {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}}


SCHEMAS = [
    schema("teacher_question_bank", "服务端 SQLite 题库：导入 DOCX/标准 JSON，查题、版本修订、派生改编、个人作业快照和作答记录。先 read 获取当前版本；修改保留原文，compose 不发布作业。review_status 不是模型自证正确。", {
        "action": prop("string", enum=["import", "batches", "search", "read", "revise", "adapt", "compose", "paper", "attempt"]),
        "path": prop("string"), "title": prop("string"), "tags": prop("array", items=prop("string")),
        "expected_count": prop("integer"), "query": prop("string"), "kind": prop("string"),
        "batch_id": prop("string"), "limit": prop("integer"), "offset": prop("integer"),
        "item_id": prop("string"), "revision": prop("integer"), "expected_revision": prop("integer"),
        "changes": prop("object"), "reason": prop("string"), "purpose": prop("string"),
        "student_id": prop("string"), "evidence": SOURCES,
        "selections": prop("array", items=prop("object", properties={
            "item_id": prop("string"), "revision": prop("integer"), "task": prop("object")
        }, required=["item_id", "revision"], additionalProperties=False)),
        "paper_id": prop("string"), "position": prop("integer"), "response": prop("string"),
        "assistance": prop("object"), "assessment": prop("object")
    }, ["action"]),
    schema("teacher_organize", "按录音内容跨文件整理活动草稿。不能推定学生实名；教师确认后才入库。先 context 读取当前草稿和原文版本，propose 必须保留全部有效内容，仅少量歧义片段设置 question。", {
        "action": prop("string", enum=["context", "propose"]),
        "asset_id": prop("string", "context 时指定录音，仅加载当日相邻录音"),
        "asset_ids": prop("array", items=prop("string")),
        "activities": prop("array", items=prop("object", properties={
            "id": prop("string"), "expected_revision": prop("integer"),
            "title": prop("string"), "kind": prop("string", enum=["class", "conversation", "other"]),
            "period": prop("string"), "events": prop("array", items=prop("object", properties={
                "title": prop("string"), "detail": prop("string"), "question": prop("string"), "sources": SOURCES
            }, required=["title", "detail", "sources"], additionalProperties=False))
        }, required=["title", "kind", "events"], additionalProperties=False))
    }, ["action"]),
    schema("teacher_context", "查看当前教师空间、名单、资料覆盖与待确认问题。", {"action": prop("string", enum=["overview", "questions"]), **SCOPE, "lesson_id": prop("string"), "status": prop("string", enum=["open", "answered", "skipped"]), "limit": prop("integer")}, ["action"]),
    schema("teacher_import", "导入指定路径的教学资料。成绩/名单格式见 Skill，时间与身份未知时保留未知。", {
        "action": prop("string", enum=["roster", "lesson", "transcript", "audio", "scores", "document", "link"]),
        "path": prop("string"), "class_id": prop("string"), "class_name": prop("string"), "lesson_id": prop("string"),
        "topic": prop("string"), "occurred_at": prop("string"), "version": prop("string"), "asset_id": prop("string"),
        "start": prop("number"), "end": prop("number"), "exam_id": prop("string"), "title": prop("string"),
        "questions": prop("array", items=QUESTION)}, ["action"]),
    schema("teacher_read", "读取当前事实和片段连续上下文；source_changed 的事件不可当当前结论。", {"kind": prop("string", enum=["event", "segment", "asset", "exam", "score", "lesson", "question", "job", "message"]), "object_id": prop("string"), "context": prop("integer", minimum=0, maximum=10)}, ["kind", "object_id"]),
    schema("teacher_query", "按真实覆盖范围检索，或以确定性程序统计成绩。短词使用字面子串，aliases 可扩展同义词。", {"action": prop("string", enum=["evidence", "statistics"]), **SCOPE, "text": prop("string"), "aliases": prop("array", items=prop("string")), "limit": prop("integer"), "offset": prop("integer"), "exam_id": prop("string")}, ["action"]),
    schema("teacher_record", "保存教学事件、教师观察或待确认问题。学生实名必须有本轮教师确认，模型推测与原文事实分开。", {
        "action": prop("string", enum=["event", "observation", "question"]), "lesson_id": prop("string"),
        "event_id": prop("string"), "event_type": prop("string"), "content": prop("object"), "sources": SOURCES,
        "kind": prop("string", enum=["observed", "inference", "teacher_observation"]), "student_id": prop("string"), "text": prop("string")}, ["action", "lesson_id"]),
    schema("teacher_correct", "对明确目标追加教师更正，校验版本并立即失效旧报告；教师消息由运行时绑定。", {
        "action": prop("string", enum=["apply", "skip_question"]), "target_kind": prop("string", enum=["event", "segment", "lesson", "score"]),
        "target_id": prop("string"), "expected_revision": prop("integer"), "changes": prop("object"), "question_id": prop("string")}, ["action"]),
    schema("teacher_artifact", "保存或读取报告与备课，必须引用当前来源；过期草稿不会作为有效产物。", {
        "action": prop("string", enum=["save", "read", "list"]), "kind": prop("string", enum=["brief", "preparation", "exercise", "courseware", "student_summary"]),
        "title": prop("string"), "sources": SOURCES, "text": prop("string"), "path": prop("string"), "artifact_id": prop("string"), "include_stale": prop("boolean")}, ["action"]),
    schema("teacher_job", "领取和完成持久化任务，或跟进同一 ASR 任务。转写就绪不等于复盘完成。", {
        "action": prop("string", enum=["enqueue", "claim", "heartbeat", "complete", "recover", "list", "submit_audio", "poll_audio", "asr_health"]),
        "kind": prop("string", enum=["audio", "review", "courseware"]), "input_version": prop("string"), "asset_id": prop("string"), "lesson_id": prop("string"),
        "job_id": prop("string"), "owner": prop("string"), "fence": prop("integer"), "artifact_id": prop("string"), "state": prop("string"), "diarize": prop("boolean"), "speakers": prop("integer")}, ["action"]),
    schema("teacher_courseware", "把有效备课交给已有 Hermes 课件 Skill，在独立制作会话内生成 PPTX，保留来源和任务状态。", {
        "action": prop("string", enum=["prepare", "run", "status"]), "preparation_id": prop("string"), "job_id": prop("string"), "requirements": prop("string")}, ["action"]),
]


def register_plugin(ctx, workbench: Workbench | None = None):
    if workbench is None:
        from hermes_constants import get_hermes_home
        workbench = Workbench(Config.load(home=Path(get_hermes_home())))
    workbench.jobs.recover()
    bindings = {}
    lock = threading.RLock()
    skill_path = Path(__file__).parents[1] / "skills" / "teacher-workbench" / "SKILL.md"
    ctx.register_skill("teacher-workbench", skill_path, description="基于当前资料复盘、查询、更正和备课")
    body = skill_path.read_text(encoding="utf-8").split("---", 2)[-1].strip()
    ctx.register_system_prompt_section("teacher-workbench.rules", body, max_chars=4000)
    ctx.register_system_prompt_section("teacher-workbench.delivery", DELIVERY_RULE, max_chars=2000)

    def current(task_id=None, session_id=None):
        with lock:
            for key in (task_id, session_id):
                if key and key in bindings:
                    return dict(bindings[key])
            if task_id or session_id:
                return {}
            # Oneshot Hermes versions can omit task_id when dispatching tools. Only a
            # single distinct active turn may use that fallback, never another chat's turn.
            unique = {v["message_id"]: v for v in bindings.values()}
            return dict(next(iter(unique.values()))) if len(unique) == 1 else {}

    def handler_for(name):
        def handle(args, task_id=None, session_id=None, **kwargs):
            try:
                result = workbench.invoke(name, args, current(task_id, session_id))
                return encode({"ok": True, "result": result})
            except (WorkbenchError, TypeError, KeyError, OSError, ValueError, subprocess.SubprocessError) as exc:
                return encode({"ok": False, "error": str(exc)[:1500]})
        return handle

    for definition in SCHEMAS:
        ctx.register_tool(name=definition["name"], toolset="teacher_workbench", schema=definition,
                          handler=handler_for(definition["name"]), description=definition["description"])

    def before_turn(session_id=None, user_message=None, platform="cli", task_id=None, turn_id=None, sender_id=None, **kwargs):
        sid = session_id or task_id or "oneshot"
        message = workbench.facts.message(user_message or "教师入口任务", sid, platform, sender_id, turn_id)
        frame = {"message_id": message["id"], "session_id": sid}
        if os.environ.get("HERMES_RECORDING_WORKFLOW"):
            frame["recording_workflow"] = json.loads(os.environ["HERMES_RECORDING_WORKFLOW"])
        with lock:
            bindings[sid] = frame
            if task_id:
                bindings[task_id] = frame
        questions = workbench.query.questions()
        ready = workbench.jobs.list("ready")["jobs"][:3]
        waiting = workbench.jobs.list("waiting_external")["jobs"][:3]
        return {"context": DELIVERY_RULE + "\n教师插件运行上下文（由宿主绑定）：" + encode({"workspace_id": workbench.store.config.workspace_id,
                "current_message_id": message["id"], "pending_questions": questions, "ready_jobs": ready, "waiting_jobs": waiting,
                "pending_recordings": workbench.query.pending_recordings(5)})}

    def observe(tool_name=None, result=None, **kwargs):
        if tool_name and tool_name.startswith("teacher_"):
            try:
                successful = json.loads(result).get("ok") if isinstance(result, str) else None
            except ValueError:
                successful = None
            with workbench.store.transaction() as db:
                workbench.store.audit(db, "tool", tool_name, {"ok": successful})

    def session_end(session_id=None, **kwargs):
        with lock:
            for key in [k for k, v in bindings.items() if v["session_id"] == session_id]:
                bindings.pop(key, None)

    ctx.register_hook("on_session_start", lambda **kwargs: workbench.jobs.recover())
    ctx.register_hook("pre_llm_call", before_turn)
    ctx.register_hook("post_tool_call", observe)
    ctx.register_hook("on_session_end", session_end)
    return workbench
