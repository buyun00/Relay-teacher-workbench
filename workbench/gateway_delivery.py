"""Delivery extension installed inside the existing smart-chat-router plugin."""
from __future__ import annotations

import asyncio
import threading
from pathlib import Path

from .delivery_policy import DELIVERY_RULE, attachment_text, collect_outputs, output_snapshot, recover_delivery_state


def file_receipt(payload, staff):
    """An empty HTTP 200, rejection, or missing send identity is not a file receipt."""
    if not isinstance(payload, dict) or payload.get('errcode', 0) or payload.get('success') is False:
        raise RuntimeError('钉钉未确认文件消息发送')
    if staff in payload.get('invalidUserIds', []) or staff in payload.get('flowControlledStaffIdList', []):
        raise RuntimeError('钉钉拒绝向原对话发送文件')
    reference = payload.get('processQueryKey')
    if not isinstance(reference, str) or not reference:
        raise RuntimeError('钉钉未返回文件消息回执')
    return {'state': 'sent', 'external_ref': reference}


def enable_file_delivery(adapter, event, sender):
    """Bind file sends to this authorized original DM through the plugin's uploader."""
    from gateway.platforms.base import SendResult
    origins = getattr(adapter, '_teacher_file_origins', None)
    if origins is None:
        origins = adapter._teacher_file_origins = {}
        adapter._teacher_file_sender = sender

        def wrap(original):
            async def send(chat_id, file_path=None, caption=None, file_name=None, reply_to=None, metadata=None, **kwargs):
                path = file_path or kwargs.get('image_path') or kwargs.get('video_path') or kwargs.get('video_url') or kwargs.get('audio_path')
                origin = origins.get(str(chat_id))
                if origin is None:
                    remaining = {k: v for k, v in kwargs.items() if k not in {'image_path', 'video_path', 'video_url', 'audio_path'}}
                    return await original(chat_id, path, caption=caption, reply_to=reply_to, metadata=metadata, **remaining)
                try:
                    target = Path(path).expanduser()
                    if not target.is_file():
                        raise ValueError('成品文件不存在')
                    receipt = await adapter._teacher_file_sender(adapter, origin, target)
                    if not isinstance(receipt, dict) or receipt.get('state') != 'sent' or not receipt.get('external_ref'):
                        raise RuntimeError('文件消息未获得发送回执')
                    return SendResult(success=True, message_id=receipt['external_ref'])
                except Exception as exc:
                    # No credentials, provider responses, or local paths in user-facing errors.
                    return SendResult(success=False, error='成品附件尚未交付（' + type(exc).__name__ + '）')
            return send

        for name in ('send_document', 'send_image_file', 'send_video', 'send_audio', 'send_voice'):
            method = getattr(adapter, name, None)
            if callable(method):
                setattr(adapter, name, wrap(method))
    # Existing wrappers keep their state during a native plugin reload.
    adapter._teacher_file_sender = sender
    origins[str(event.source.chat_id)] = {
        'staff': event.source.user_id_alt, 'robot': getattr(adapter, '_client_id', ''),
        'source': {'chat_id': event.source.chat_id},
    }


def register(ctx):
    frames, lock = {}, threading.RLock()
    ctx.register_system_prompt_section('original-conversation.delivery', DELIVERY_RULE, max_chars=2000)

    def before(session_id=None, turn_id=None, platform=None, parent_session_id=None, **kwargs):
        if platform not in {'dingtalk', 'feishu', 'lark'} or parent_session_id or not session_id:
            return
        from hermes_state import SessionDB
        from hermes_cli.config import load_config
        db = SessionDB()
        try:
            session = db.get_session(session_id) or {}
        finally:
            db.close()
        cwd = Path(session.get('cwd') or load_config().get('terminal', {}).get('cwd') or Path.cwd())
        output = cwd / 'output' / session_id
        output.mkdir(parents=True, exist_ok=True)
        with lock:
            frame = (cwd, output, output_snapshot(output))
            frames[session_id] = frame
            if turn_id:
                frames[turn_id] = frame
        return {'context': DELIVERY_RULE + '\n本轮成品目录：' + str(output)}

    def transform(response_text=None, session_id=None, turn_id=None, platform=None, **kwargs):
        if platform not in {'dingtalk', 'feishu', 'lark'}:
            return
        with lock:
            frame = frames.get(session_id) or frames.get(turn_id)
            if frame:
                for name in [name for name, value in frames.items() if value is frame]:
                    frames.pop(name, None)
        if not frame:
            return
        cwd, output, before_files = frame
        try:
            paths = collect_outputs(response_text, output, before_files, cwd)
            if paths:
                # Native gateway media routing handles the original chat and its send failures.
                prose = attachment_text(response_text, paths, cwd)
                return prose + '\n\n[[as_document]]\n' + '\n'.join('MEDIA:"' + str(p) + '"' for p in paths)
        except (OSError, ValueError):
            return '成品尚未交付：未取得可发送的实际文件。制作记录已保留，可继续处理文件交付。'

    def end(session_id=None, **kwargs):
        with lock:
            frame = frames.get(session_id)
            for name in [name for name, value in frames.items() if name == session_id or value is frame]:
                frames.pop(name, None)

    ctx.register_hook('pre_llm_call', before)
    ctx.register_hook('transform_llm_output', transform)
    ctx.register_hook('on_session_end', end)


async def watch(router, adapter, job, sid, turn, key, backend):
    """Send every finished file before sealing the original conversation's final card."""
    last = None
    try:
        while True:
            state = backend.load(sid)
            rows = [m for m in state['messages'] if m.get('turnId') == turn]
            final_row = next((m for m in reversed(rows) if m.get('phase') == 'final'), {})
            final = final_row.get('text', '')
            done = state['state'] != 'active'
            preset = state.get('gpt_preset')
            job['model_info'] = (dict(zip(('model', 'effort'), backend.TIERS.PRESETS[preset]))
                                 if state.get('stage') != 'intake' and preset else {'model': 'DeepSeek', 'effort': '需求沟通'})
            if not done:
                text = state.get('progress_text', '正在整理需求。')
                if text != last:
                    await router.deliver(job, text, False)
                    last = text
                await asyncio.sleep(3)
                continue

            files = (await backend.control('GET', f'/sessions/{sid}/artifacts'))['files']
            for item in files:
                item['path'] = backend.artifact_path(sid, item['name'])
            declaration_error = False
            try:
                selected = collect_outputs(final, backend.folder(sid) / 'output', {}, backend.folder(sid))
                known = {item['path'].resolve() for item in files}
                for path in selected:
                    if path not in known:
                        stat = path.stat()
                        files.append({'name': str(path), 'path': path, 'size': stat.st_size, 'modified': stat.st_mtime_ns})
            except (OSError, ValueError):
                declaration_error = True
            delivered = state.setdefault('main_delivered', {})
            failures = ['声明的成品尚未取得实际文件'] if declaration_error else []
            if state.get('delivery_turn') != turn:
                state.update(delivery_turn=turn, production_final=final, production_stage=state.get('stage'))
            if files:
                await router.deliver(job, '成品已保存，正在发送到这段对话。', False)
            state['delivery_state'] = 'pending'
            state['state'] = 'delivering'
            backend.store(state)
            for item in files:
                version = str(item['modified']) + ':' + str(item['size'])
                if delivered.get(item['name']) == version:
                    continue
                try:
                    receipt = await adapter._teacher_file_sender(adapter, job, item['path'])
                    if not receipt or receipt.get('state') != 'sent' or not receipt.get('external_ref'):
                        raise RuntimeError('Missing file receipt')
                    delivered[item['name']] = version
                    state.setdefault('file_receipts', {})[item['name']] = receipt
                    backend.store(state)
                except Exception as exc:
                    failures.append(item['name'])
                    state.setdefault('file_errors', {})[item['name']] = type(exc).__name__
                    backend.store(state)
            production = state.get('stage') != 'intake'
            if production and state.get('stage') in {'completed', 'delivery_failed'} and not files:
                failures.append('尚无可发送的实际成品')
            if failures:
                state.setdefault('production_stage', state.get('stage'))
                state['stage'] = 'delivery_failed'
                state['delivery_state'] = 'failed'
                final = '成品尚未完整交付：' + '、'.join(failures) + '。已生成和已发送的文件保留，请回复“重发”重试文件交付。'
            else:
                state['delivery_state'] = 'sent' if files else 'not_required'
                if state.get('stage') == 'delivery_failed':
                    state['stage'] = state.get('production_stage', 'completed')
                final = attachment_text(state.get('production_final', final), [item['path'] for item in files], backend.folder(sid)) or '本轮处理已结束。'
            final_row['text'] = final
            state['progress_text'] = '成品已发送到原对话。' if files and not failures else final
            backend.store(state)
            await router.deliver(job, final, True)
            chat = router.read('chats', key) or {}
            if chat.get('courseware_session') == sid:
                chat['history'] = (chat.get('history', []) + [{'role': 'assistant', 'content': final}])[-30:]
                router.save('chats', key, chat)
            state['state'] = 'idle'
            backend.store(state)
            break
    except Exception:
        router.LOG.exception('Original-conversation delivery failed; task files retained')
        state = backend.load(sid)
        state.setdefault('production_stage', state.get('stage'))
        state.update(state='idle', stage='delivery_failed', delivery_state='failed')
        backend.store(state)
    finally:
        if getattr(adapter, '_smart_reply_cards', {}).get(job['source']['chat_id']) is job:
            adapter._smart_reply_cards.pop(job['source']['chat_id'], None)


def retry_requested(state, text, media_urls):
    return (state and state.get('delivery_state') == 'failed' and state.get('production_stage') == 'completed'
            and not media_urls and (text or '').strip() in {'继续', '重发', '重试', '重新发送', '再发一次', '发送文件', '发送成品', '把文件发给我'})
