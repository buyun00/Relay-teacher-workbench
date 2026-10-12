"""Durable desktop turns. Native Hermes owns model history and tool execution."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from .config import WorkbenchError
from .storage import encode, now


DEFAULT_MODELS = (
    {"id": "deepseek-flash", "label": "DeepSeek Flash", "provider": "custom", "purpose": "日常沟通、资料整理"},
    {"id": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "provider": "custom", "purpose": "写作、讲稿与教学文字"},
    {"id": "gpt-6-sol", "label": "GPT-6 Sol", "provider": "openai-codex", "purpose": "制作功能、代码与通用任务"},
    {"id": "gpt-6-astra", "label": "GPT-6 Astra", "provider": "openai-codex", "purpose": "数学推理、复杂备课与课件"},
)
ACTIVE = {"queued", "running", "cancelling"}


def valid_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
        raise WorkbenchError("对话标识无效")
    return value


class Chats:
    def __init__(self, store):
        self.store = store

    def models(self):
        return {"models": [{k: m[k] for k in ("id", "label", "purpose")} for m in self.catalog()],
                "triage_model": self.store.config.chat_triage_model}

    def catalog(self):
        return self.store.config.chat_models or DEFAULT_MODELS

    def model(self, model_id):
        for item in self.catalog():
            if item["id"] == model_id:
                return item
        raise WorkbenchError("所选模型不可用，请刷新模型列表")

    def _event(self, db, chat_id, turn_id, kind, payload):
        cur = db.execute("INSERT INTO desktop_chat_events(chat_id,turn_id,kind,payload,at) VALUES(?,?,?,?,?)",
                         (chat_id, turn_id, kind, encode(payload), now()))
        return cur.lastrowid

    def event(self, chat_id, turn_id, kind, payload):
        with self.store.transaction() as db:
            self._event(db, chat_id, turn_id, kind, payload)

    def create(self, payload):
        chat_id = valid_id(payload.get("id"))
        stamp = now()
        with self.store.transaction() as db:
            db.execute("INSERT OR IGNORE INTO desktop_chats(id,hermes_session_id,native_tip,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                       (chat_id, "teacher-desktop-" + chat_id, "teacher-desktop-" + chat_id, "新任务", stamp, stamp))
        return self.read(chat_id)

    def list(self):
        with self.store.connect() as db:
            rows = db.execute("SELECT c.*, (SELECT state FROM desktop_turns WHERE chat_id=c.id ORDER BY rowid DESC LIMIT 1) AS state FROM desktop_chats c ORDER BY updated_at DESC").fetchall()
        return {"chats": [dict(row) for row in rows], "workspace_id": self.store.config.workspace_id}

    def chat(self, chat_id, db=None):
        valid_id(chat_id)
        if db is None:
            with self.store.connect() as conn:
                return self.chat(chat_id, conn)
        row = db.execute("SELECT * FROM desktop_chats WHERE id=?", (chat_id,)).fetchone()
        if not row:
            raise WorkbenchError("对话不存在")
        return dict(row)

    def read(self, chat_id):
        with self.store.connect() as db:
            db.execute("BEGIN")  # Snapshot and cursor describe the same committed generation.
            chat = self.chat(chat_id, db)
            turns = [dict(r) for r in db.execute("SELECT * FROM desktop_turns WHERE chat_id=? ORDER BY rowid", (chat_id,))]
            cursor = db.execute("SELECT COALESCE(MAX(seq),0) FROM desktop_chat_events WHERE chat_id=?", (chat_id,)).fetchone()[0]
            events = self._events(db, chat_id, 0, kinds=("tool_start", "tool_end", "status", "route", "notice", "commentary"))
        return {"chat": chat, "turns": turns, "events": events, "cursor": cursor,
                "workspace_id": self.store.config.workspace_id}

    def _events(self, db, chat_id, after, kinds=None):
        sql, values = "SELECT * FROM desktop_chat_events WHERE chat_id=? AND seq>?", [chat_id, after]
        if kinds:
            sql += " AND kind IN (" + ",".join("?" for _ in kinds) + ")"
            values.extend(kinds)
        return [{**dict(r), "payload": json.loads(r["payload"])} for r in db.execute(sql + " ORDER BY seq" + ("" if kinds else " LIMIT 1000"), values)]

    def events(self, chat_id, after):
        with self.store.connect() as db:
            self.chat(chat_id, db)
            return self._events(db, chat_id, after)

    def submit(self, chat_id, payload):
        turn_id = valid_id(payload.get("id"))
        content = payload.get("content")
        if not isinstance(content, str) or not content.strip():
            raise WorkbenchError("请先输入消息")
        stamp = now()
        with self.store.transaction() as db:
            chat = self.chat(chat_id, db)
            old = db.execute("SELECT * FROM desktop_turns WHERE id=?", (turn_id,)).fetchone()
            if old:
                if old["chat_id"] != chat_id or old["content"] != content:
                    raise WorkbenchError("消息标识已用于另一条消息")
                return dict(old)
            if db.execute("SELECT 1 FROM desktop_turns WHERE chat_id=? AND state IN ('queued','running','cancelling')", (chat_id,)).fetchone():
                raise WorkbenchError("当前回复正在进行，请等待或停止后发送")
            db.execute("INSERT INTO desktop_turns(id,chat_id,content,created_at,updated_at) VALUES(?,?,?,?,?)",
                       (turn_id, chat_id, content, stamp, stamp))
            first = db.execute("SELECT COUNT(*) FROM desktop_turns WHERE chat_id=?", (chat_id,)).fetchone()[0] == 1
            db.execute("UPDATE desktop_chats SET title=?,updated_at=? WHERE id=?",
                       (content.strip().splitlines()[0][:36] if first else chat["title"], stamp, chat_id))
            self._event(db, chat_id, turn_id, "turn", {"id": turn_id, "content": content, "state": "queued", "answer": "", "created_at": stamp})
        return self.turn(turn_id)

    def turn(self, turn_id):
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM desktop_turns WHERE id=?", (valid_id(turn_id),)).fetchone()
        if not row:
            raise WorkbenchError("消息不存在")
        return dict(row)

    def select_model(self, chat_id, payload):
        model_id = payload.get("model_id")
        if model_id != "auto":
            self.model(model_id)
        with self.store.transaction() as db:
            self.chat(chat_id, db)
            if db.execute("SELECT 1 FROM desktop_turns WHERE chat_id=? AND state IN ('queued','running','cancelling')", (chat_id,)).fetchone():
                raise WorkbenchError("请在回复结束或停止后切换模型")
            state = "triage" if model_id == "auto" else "locked"
            reason = "DS 将根据接下来几轮需求选择模型" if model_id == "auto" else "你手动选择了此模型"
            db.execute("UPDATE desktop_chats SET route_state=?,model_id=?,route_reason=?,updated_at=? WHERE id=?",
                       (state, None if model_id == "auto" else model_id, reason, now(), chat_id))
            self._event(db, chat_id, None, "route", {"route_state": state, "model_id": None if model_id == "auto" else model_id, "route_reason": reason})
        return self.read(chat_id)

    def route(self, chat_id, turn_id, proposal, user_count):
        """The classifier proposes; code validates and owns the lock boundary."""
        self.model(proposal.get("model_id"))
        if not isinstance(proposal.get("ready"), bool) or not isinstance(proposal.get("reason"), str):
            raise WorkbenchError("DS 分类结果格式无效")
        confidence = proposal.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise WorkbenchError("DS 分类置信度无效")
        with self.store.transaction() as db:
            chat = self.chat(chat_id, db)
            if chat["route_state"] == "locked":
                return chat
            locked = user_count >= 3 or (user_count >= 2 and proposal["ready"] and confidence >= .75)
            state, model_id = ("locked", proposal["model_id"]) if locked else ("triage", None)
            reason = proposal["reason"] if locked else "DS 正在了解需求（第 %s 轮）" % user_count
            db.execute("UPDATE desktop_chats SET route_state=?,model_id=?,route_reason=?,category=?,updated_at=? WHERE id=?",
                       (state, model_id, reason, str(proposal.get("category", "通用")), now(), chat_id))
            self._event(db, chat_id, turn_id, "route", {"route_state": state, "model_id": model_id, "route_reason": reason})
        return self.chat(chat_id)

    def cancel(self, chat_id):
        with self.store.transaction() as db:
            self.chat(chat_id, db)
            row = db.execute("SELECT * FROM desktop_turns WHERE chat_id=? AND state IN ('queued','running','cancelling')", (chat_id,)).fetchone()
            if row:
                state = "cancelled" if row["state"] == "queued" else "cancelling"
                db.execute("UPDATE desktop_turns SET state=?,updated_at=? WHERE id=?", (state, now(), row["id"]))
                self._event(db, chat_id, row["id"], "state", {"state": state})
        return self.read(chat_id)

    def finish(self, turn_id, state, answer=None, error=None):
        with self.store.transaction() as db:
            row = dict(db.execute("SELECT * FROM desktop_turns WHERE id=?", (turn_id,)).fetchone())
            if row["state"] not in ACTIVE:
                return
            if row["state"] == "cancelling":
                state = "cancelled"
            answer = row["answer"] if answer is None else answer
            db.execute("UPDATE desktop_turns SET state=?,answer=?,error=?,updated_at=? WHERE id=?", (state, answer, error, now(), turn_id))
            self._event(db, row["chat_id"], turn_id, "done", {"state": state, "answer": answer, "error": error})

    def delta(self, turn_id, text):
        with self.store.transaction() as db:
            row = db.execute("SELECT chat_id,state FROM desktop_turns WHERE id=?", (turn_id,)).fetchone()
            if row["state"] not in ACTIVE:
                return
            db.execute("UPDATE desktop_turns SET answer=answer||?,updated_at=? WHERE id=?", (text, now(), turn_id))
            self._event(db, row["chat_id"], turn_id, "delta", {"text": text})


class ChatWorker:
    """Own only these native turn processes; reconnect never resubmits a turn."""
    def __init__(self, chats):
        self.chats, self.stop_event = chats, threading.Event()
        self.children = {}
        self.thread = None

    def start(self):
        with self.chats.store.connect() as db:
            old = [r[0] for r in db.execute("SELECT id FROM desktop_turns WHERE state IN ('running','cancelling')")]
        for turn_id in old:
            self.chats.finish(turn_id, "interrupted", error="服务重启中断了回复；已保存内容，发送下一条消息可继续。")
        self.thread = threading.Thread(target=self.run, name="desktop-chat-worker", daemon=True)
        self.thread.start()

    def run(self):
        while not self.stop_event.wait(.25):
            for turn_id, child in list(self.children.items()):
                if child.poll() is not None:
                    self.chats.finish(turn_id, "failed", error="模型进程已退出；已保存内容，可继续对话。")
                    del self.children[turn_id]
            if len(self.children) >= 2:
                continue
            with self.chats.store.transaction() as db:
                row = db.execute("SELECT * FROM desktop_turns WHERE state='queued' ORDER BY rowid LIMIT 1").fetchone()
                if not row:
                    continue
                db.execute("UPDATE desktop_turns SET state='running',updated_at=? WHERE id=?", (now(), row["id"]))
                self.chats._event(db, row["chat_id"], row["id"], "state", {"state": "running"})
            env = dict(os.environ)
            env.pop("HERMES_RECORDING_WORKFLOW", None)
            native = self.chats.store.config.hermes_command
            if native:
                env["PYTHONPATH"] = str(native.parent.parent) + os.pathsep + str(Path(__file__).parents[1])
            try:
                self.children[row["id"]] = subprocess.Popen([sys.executable, "-m", "workbench.chat_runner", "--root", str(self.chats.store.root), "--turn", row["id"]],
                    env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except OSError:
                self.chats.finish(row["id"], "failed", error="无法启动模型服务，请检查服务器配置。")

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(2)
        for turn_id in self.children:
            self.chats.cancel(self.chats.turn(turn_id)["chat_id"])
        deadline = time.monotonic() + 12
        for child in self.children.values():
            try:
                child.wait(max(.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.terminate()
                try:
                    child.wait(3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        for turn_id in self.children:
            self.chats.finish(turn_id, "interrupted", error="服务正在重启，已保存内容。")
