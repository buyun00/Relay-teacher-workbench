"""Persist generated files as assistant attachments in the originating turn."""
from __future__ import annotations

import mimetypes
import os
import shutil
from pathlib import Path

from .attachments import ChatAttachments, public_attachment
from .config import WorkbenchError
from .storage import identifier, now


class ChatDeliveries:
    def __init__(self, chats):
        self.chats, self.store = chats, chats.store
        self.files = ChatAttachments(chats)

    def stage(self, turn_id, paths):
        for source in paths:
            source = Path(source).resolve()
            stat = source.stat()
            turn = self.chats.turn(turn_id)
            identity = (turn_id, str(source), stat.st_size, stat.st_mtime_ns)
            with self.store.connect() as db:
                if db.execute('SELECT 1 FROM desktop_turn_outputs WHERE turn_id=? AND source_path=? '
                              'AND source_size=? AND source_mtime=?', identity).fetchone():
                    continue
            if turn['state'] not in {'running', 'queued'}:
                raise WorkbenchError('本轮已停止，不能继续添加成品')
            aid = identifier('result')
            target = self.files.path({'id': aid, 'filename': source.name})
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name('.copying')
            committed = False
            try:
                # Large videos must not hold the shared SQLite writer lock while copying.
                with source.open('rb') as incoming, temporary.open('xb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
                    outgoing.flush()
                    os.fsync(outgoing.fileno())
                size = temporary.stat().st_size
                if size != stat.st_size:
                    raise WorkbenchError('成品复制未完成：' + source.name)
                os.replace(temporary, target)
                if os.name != 'nt':
                    fd = os.open(target.parent, os.O_RDONLY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                with self.store.transaction() as db:
                    if db.execute('SELECT 1 FROM desktop_turn_outputs WHERE turn_id=? AND source_path=? '
                                  'AND source_size=? AND source_mtime=?', identity).fetchone():
                        target.unlink(missing_ok=True)
                        continue
                    current = db.execute('SELECT state FROM desktop_turns WHERE id=?', (turn_id,)).fetchone()
                    if current['state'] not in {'running', 'queued'}:
                        raise WorkbenchError('本轮已停止，不能继续添加成品')
                    # These are new generated copies, not uploaded/imported originals. No hash rechecks.
                    db.execute('INSERT INTO desktop_chat_attachments '
                               '(id,chat_id,filename,mime,byte_length,sha256,offset,received_at) VALUES(?,?,?,?,?,\'\',?,?)',
                               (aid, turn['chat_id'], source.name, mimetypes.guess_type(source.name)[0] or
                                'application/octet-stream', size, size, now()))
                    position = db.execute('SELECT COUNT(*) FROM desktop_turn_outputs WHERE turn_id=?', (turn_id,)).fetchone()[0]
                    db.execute('INSERT INTO desktop_turn_outputs VALUES(?,?,?,?,?,?,?)',
                               (turn_id, aid, str(source), stat.st_size, stat.st_mtime_ns, position, now()))
                    file = public_attachment(self.files.row(turn['chat_id'], aid, db))
                    self.chats._event(db, turn['chat_id'], turn_id, 'artifact', {'file': file})
                    self.store.audit(db, 'chat_output_delivered', aid, {'chat_id': turn['chat_id'], 'turn_id': turn_id})
                committed = True
            finally:
                temporary.unlink(missing_ok=True)
                if not committed:
                    target.unlink(missing_ok=True)
        return self.chats.turn(turn_id)['outputs']
