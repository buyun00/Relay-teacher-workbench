from __future__ import annotations

import json

from .artifacts import Artifacts
from .config import Config, WorkbenchError
from .facts import Facts
from .jobs import Jobs
from .query import Query
from .speech import Speech
from .storage import Store, now


class Workbench:
    def __init__(self, config: Config):
        self.store = Store(config)
        self.facts = Facts(self.store)
        self.query = Query(self.store)
        self.artifacts = Artifacts(self.store)
        self.jobs = Jobs(self.store)
        self.speech = Speech(self.store)

    def invoke(self, tool: str, args: dict, context: dict | None = None) -> dict:
        if not isinstance(args, dict):
            raise WorkbenchError("工具参数必须是对象")
        a = dict(args)
        action = a.pop("action", None)
        context = context or {}
        if tool == "teacher_context":
            if action == "overview":
                result = self.query.coverage(**a)
                with self.store.connect() as db:
                    result["classes"] = [dict(r) for r in db.execute("SELECT * FROM classes")]
                    result["students"] = [dict(r) for r in db.execute("SELECT * FROM students")]
                result["current_message_id"] = context.get("message_id")
                result["pending_questions"] = self.query.questions()
                return result
            if action == "questions":
                return self.query.questions(**a)
        elif tool == "teacher_import":
            functions = {"roster": self.facts.roster, "lesson": self.facts.lesson, "transcript": self.facts.transcript_file,
                         "audio": self.speech.import_audio, "scores": self.facts.import_scores, "link": self.facts.link_asset}
            if action in functions:
                return functions[action](**a)
            if action == "document":
                lesson_id = a.pop("lesson_id", None)
                path = a.pop("path")
                title = a.pop("title", None)
                if a:
                    raise WorkbenchError("文档导入参数无效")
                if lesson_id:
                    self.store.one("lessons", lesson_id)
                asset = self.store.ingest(path, "document", {"title": title} if title else None)
                if lesson_id:
                    self.facts.link_asset(lesson_id, asset["id"])
                return asset
        elif tool == "teacher_read":
            return self.query.read(**a)
        elif tool == "teacher_query":
            if action == "evidence":
                return self.query.search(**a)
            if action == "statistics":
                return self.facts.score_stats(**a)
        elif tool == "teacher_record":
            if action == "event":
                if a.get("student_id"):
                    a["confirmation_message_id"] = self.current_message(context)
                return self.facts.event(**a)
            if action == "observation":
                a["kind"] = "teacher_observation"
                a["event_type"] = "teacher_observation"
                refs = a.setdefault("sources", [])
                refs.append({"kind": "message", "id": self.current_message(context), "revision": 1})
                if a.get("student_id"):
                    a["confirmation_message_id"] = self.current_message(context)
                return self.facts.event(**a)
            if action == "question":
                return self.facts.question(**a)
        elif tool == "teacher_correct":
            if action == "apply":
                return self.facts.correct(message_id=self.current_message(context), **a)
            if action == "skip_question":
                question_id = a.pop("question_id")
                if a:
                    raise WorkbenchError("跳过问题参数无效")
                with self.store.transaction() as db:
                    question = self.store.one("questions", question_id, db)
                    if question["status"] == "open":
                        db.execute("UPDATE questions SET status='skipped',response_message_id=?,resolved_at=? WHERE id=?", (self.current_message(context), now(), question_id))
                return self.store.one("questions", question_id)
        elif tool == "teacher_artifact":
            if action == "save":
                return self.artifacts.save(**a)
            if action == "read":
                return self.artifacts.read(**a)
            if action == "list":
                return self.artifacts.list(**a)
        elif tool == "teacher_job":
            functions = {"enqueue": self.jobs.enqueue, "claim": self.jobs.claim, "heartbeat": self.jobs.heartbeat,
                         "complete": self.jobs.complete, "recover": self.jobs.recover, "list": self.jobs.list,
                         "submit_audio": self.speech.submit, "poll_audio": self.speech.poll, "asr_health": self.speech.health}
            if action in functions:
                return functions[action](**a)
        elif tool == "teacher_courseware":
            from .courseware import Courseware
            courseware = Courseware(self.store)
            if action == "prepare":
                return courseware.prepare(**a)
            if action == "run":
                return courseware.run(**a)
            if action == "status":
                return self.store.one("jobs", a["job_id"])
        raise WorkbenchError("工具或操作名称无效")

    @staticmethod
    def current_message(context):
        value = context.get("message_id")
        if not value:
            raise WorkbenchError("缺少本轮教师消息来源；不能保存教师确认或更正")
        return value
