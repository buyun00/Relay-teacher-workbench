"""Resumable chat files; originals are backed up and never enter the recording queue."""
from __future__ import annotations

import hashlib
import os
import re
import threading
from pathlib import Path, PureWindowsPath

from .chats import valid_id
from .config import WorkbenchError
from .storage import now


def public_attachment(row):
    return {"id": row["id"], "filename": row["filename"], "mime": row["mime"],
            "bytes": row["byte_length"], "received_at": row["received_at"]}


class ChatAttachments:
    def __init__(self, chats):
        self.chats, self.store = chats, chats.store
        self.locks, self.lock = {}, threading.Lock()

    def guard(self, attachment_id):
        valid_id(attachment_id)
        with self.lock:
            return self.locks.setdefault(attachment_id, threading.Lock())

    def row(self, chat_id, attachment_id, db=None):
        valid_id(chat_id), valid_id(attachment_id)
        if db is None:
            with self.store.connect() as conn:
                return self.row(chat_id, attachment_id, conn)
        row = db.execute("SELECT * FROM desktop_chat_attachments WHERE id=? AND chat_id=?",
                         (attachment_id, chat_id)).fetchone()
        if not row:
            raise WorkbenchError("附件不存在于这段对话")
        return dict(row)

    def path(self, row):
        return self.store.root / "originals" / "chat-attachments" / row["id"] / row["filename"]

    def partial(self, row):
        return self.store.root / "temporary" / "chat-attachments" / row["id"]

    def view(self, row):
        return {**public_attachment(row), "offset": row["offset"],
                "workspace_id": self.store.config.workspace_id}

    def open(self, chat_id, manifest):
        attachment_id = valid_id(manifest.get("id"))
        filename, mime = manifest.get("filename"), manifest.get("mime", "application/octet-stream")
        size, sha = manifest.get("byte_length"), manifest.get("sha256")
        if not isinstance(filename, str) or not filename or "\0" in filename:
            raise WorkbenchError("附件文件名无效")
        filename = Path(PureWindowsPath(filename).name).name
        if filename in {"", ".", ".."}:
            raise WorkbenchError("附件文件名无效")
        if not isinstance(mime, str) or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise WorkbenchError("附件信息无效")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise WorkbenchError("附件字节数无效")
        with self.guard(attachment_id), self.store.transaction() as db:
            chat = self.chats.chat(chat_id, db)
            existing = db.execute("SELECT * FROM desktop_chat_attachments WHERE id=?", (attachment_id,)).fetchone()
            identity = (chat_id, filename, mime, size, sha)
            if existing:
                if tuple(existing[k] for k in ("chat_id", "filename", "mime", "byte_length", "sha256")) != identity:
                    raise WorkbenchError("附件标识已用于其他文件")
            else:
                if chat["archived_at"]:
                    raise WorkbenchError("请先取消归档再添加附件")
                db.execute("INSERT INTO desktop_chat_attachments(id,chat_id,filename,mime,byte_length,sha256) VALUES(?,?,?,?,?,?)",
                           (attachment_id, *identity))
            row = self.row(chat_id, attachment_id, db)
            if not row["received_at"] and row["offset"] and not self.path(row).exists() and (
                    not self.partial(row).exists() or self.partial(row).stat().st_size < row["offset"]):
                db.execute("UPDATE desktop_chat_attachments SET offset=0 WHERE id=?", (attachment_id,))
                row["offset"] = 0
        return self.view(row)

    def write(self, chat_id, attachment_id, offset, stream, length):
        with self.guard(attachment_id):
            row = self.row(chat_id, attachment_id)
            if row["received_at"]:
                while length:
                    chunk = stream.read(min(length, 1024 * 1024))
                    if not chunk:
                        raise WorkbenchError("附件分块未传完")
                    length -= len(chunk)
                return self.view(row)
            if offset != row["offset"] or length <= 0 or offset + length > row["byte_length"]:
                raise WorkbenchError("附件传输位置不一致，请重试")
            target = self.partial(row)
            target.parent.mkdir(parents=True, exist_ok=True)
            if offset and (not target.exists() or target.stat().st_size < offset):
                raise WorkbenchError("附件临时文件缺失，请重试")
            with target.open("r+b" if target.exists() else "w+b") as out:
                out.truncate(offset)
                out.seek(offset)
                remaining = length
                while remaining:
                    chunk = stream.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise WorkbenchError("附件分块未传完")
                    out.write(chunk)
                    remaining -= len(chunk)
                out.flush()
                os.fsync(out.fileno())
            with self.store.transaction() as db:
                db.execute("UPDATE desktop_chat_attachments SET offset=? WHERE id=?", (offset + length, attachment_id))
            return self.view(self.row(chat_id, attachment_id))

    def complete(self, chat_id, attachment_id):
        with self.guard(attachment_id):
            row = self.row(chat_id, attachment_id)
            if row["received_at"]:
                return self.view(row)  # No rehash of a saved original on receipt retries.
            if row["offset"] != row["byte_length"]:
                raise WorkbenchError("附件尚未传完")
            target, partial = self.path(row), self.partial(row)
            partial.parent.mkdir(parents=True, exist_ok=True)
            if not row["byte_length"] and not partial.exists():
                partial.touch()
            source = partial if partial.exists() else target  # Crash after move, before DB commit.
            digest = hashlib.sha256()
            with source.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            # Check only freshly transferred bytes, not imported teaching sources.
            if source.stat().st_size != row["byte_length"] or digest.hexdigest() != row["sha256"]:
                with self.store.transaction() as db:
                    db.execute("UPDATE desktop_chat_attachments SET offset=0 WHERE id=?", (attachment_id,))
                raise WorkbenchError("附件传输校验失败，请重试")
            with self.store.transaction() as db:
                target.parent.mkdir(parents=True, exist_ok=True)
                if source != target:
                    os.replace(source, target)
                if os.name != "nt":
                    fd = os.open(target.parent, os.O_RDONLY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                db.execute("UPDATE desktop_chat_attachments SET received_at=? WHERE id=?", (now(), attachment_id))
                self.store.audit(db, "chat_attachment_received", attachment_id, {"chat_id": chat_id})
            return self.view(self.row(chat_id, attachment_id))

    def content(self, chat_id, attachment_id):
        row = self.row(chat_id, attachment_id)
        if not row["received_at"]:
            raise WorkbenchError("附件尚未传完")
        return row, self.path(row)
