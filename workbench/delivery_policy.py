"""Shared original-conversation delivery policy; no model decides receipt state."""
from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote, urlsplit


DELIVERY_RULE = (
    "强制成品交付要求：凡为用户制作、生成或修改的成品，都必须在发起任务的原对话直接交付。"
    "视频、PPT、文档、表格、图片、音频、网页文件、代码及压缩包等均适用，不限文件类型。"
    "文字成果直接给出完整正文；文件成果必须发送实际文件附件，多个成品逐个发送。"
    "网址、下载地址、服务器路径或‘已保存’只能补充说明，不能代替附件交付。"
    "将所有最终文件放入本轮指定的成品目录，过程脚本、日志和缓存放在其它目录。"
    "最终回复为每个成品单独写一行 MEDIA:\"绝对文件路径\"，由当前对话的发送链路发送附件。"
    "远程生成的成品先用现有工具取得实际文件再交付。"
    "后台制作也必须回到原对话发送；不要另开会话、换收件人或要求用户再索取。"
    "文件生成与文件交付是两件事；发送失败须明确说尚未交付并保留成品供重试，不能宣称已交付。"
)

_MEDIA = re.compile(r'(?m)^\s*[`*_]{0,3}MEDIA:\s*(.+?)\s*$')
_LINK = re.compile(r'!?\[([^\]\n]*)\]\(<?([^\n]+?)>?\)')
_CODE_PATH = re.compile(r'`((?:/|[A-Za-z]:[\\/]|~/)[^`\r\n]+)`')
_BARE_PATH = re.compile(r'(?<![\w:/])(?:/[\w.-]+(?:/[^\s`<>"\'，。；：！？、）)\]}]+)+|[A-Za-z]:[\\/][^\s`<>"\'，。；：！？、）)\]}]+)')


def _local_path(value, cwd):
    value = value.strip().strip('`*_').strip().strip('"\'')
    if value.startswith('sandbox:'):
        value = value[len('sandbox:'):]
    parsed = urlsplit(value)
    if parsed.scheme == 'file':
        value = unquote(parsed.path)
    elif parsed.scheme and not re.match(r'^[A-Za-z]:[\\/]', value):
        return None
    else:
        value = unquote(value)
    path = Path(value).expanduser()
    return (path if path.is_absolute() else Path(cwd) / path).resolve()


def local_references(text, cwd):
    """Explicit attachments/links must exist; incidental path mentions are optional."""
    # Example code is not an attachment declaration.
    prose = re.sub(r'```.*?```', '', text or '', flags=re.S)
    references = []
    for match in _MEDIA.finditer(prose):
        path = _local_path(match.group(1), cwd)
        if path is None:
            raise ValueError('成品仅提供了远程地址，尚未取得可发送的实际文件')
        references.append((path, True))
    for match in _LINK.finditer(prose):
        path = _local_path(match.group(2), cwd)
        if path is not None:
            references.append((path, True))
    for pattern in (_CODE_PATH, _BARE_PATH):
        for match in pattern.finditer(prose):
            path = _local_path(match.group(1) if pattern is _CODE_PATH else match.group(0), cwd)
            if path is not None and path.is_file():
                references.append((path, False))
    return references


def output_snapshot(folder):
    return {str(p.resolve()): (p.stat().st_size, p.stat().st_mtime_ns)
            for p in sorted(Path(folder).rglob('*')) if p.is_file()}


def collect_outputs(text, folder, before, cwd):
    paths = []
    for path, required in local_references(text, cwd):
        if not path.is_file():
            if required:
                raise ValueError('成品文件不存在，尚未交付：' + path.name)
            continue
        if path not in paths:
            paths.append(path)
    for name, version in output_snapshot(folder).items():
        path = Path(name)
        if before.get(name) != version and path not in paths:
            paths.append(path)
    prose = re.sub(r'```.*?```', '', text or '', flags=re.S)
    download_link = any(re.search(r'下载|成品|附件|取回', match.group(1)) and
                        urlsplit(match.group(2)).scheme in {'http', 'https'}
                        for match in _LINK.finditer(prose))
    remote_claim = (re.search(r'https?://', prose) and
                    re.search(r'已(?:经)?(?:完成|制作|生成|修改|保存|导出)|(?:制作|生成|修改|导出)(?:完成|好了)|成品|作品', prose))
    if not paths and (download_link or remote_claim):
        raise ValueError('只返回了成品下载地址，尚未在原对话发送实际文件')
    return paths


def attachment_text(text, paths, cwd):
    """Keep useful prose while file cards carry local download/preview actions."""
    selected = {str(p.resolve()) for p in paths}
    text = _MEDIA.sub('', text or '')
    def link(match):
        path = _local_path(match.group(2), cwd)
        return match.group(1) or path.name if path is not None and str(path) in selected else match.group(0)
    text = _LINK.sub(link, text)
    for path in paths:
        text = text.replace(str(path), path.name)
    return text.strip() or ('成品已附在这条回复中。' if paths else '')


def recover_delivery_state(state):
    """Recover an interrupted sender without repeating finished production or receipts."""
    if state.get('state') != 'delivering':
        return False
    turn = state.get('turn')
    final = next((m for m in reversed(state.get('messages', []))
                  if m.get('turnId') == turn and m.get('phase') == 'final'), None)
    state.setdefault('production_stage', state.get('stage'))
    state.setdefault('production_final', (final or {}).get('text', ''))
    state.setdefault('delivery_turn', turn)
    message = '成品交付中断，已制作的文件和已发送回执保留。请回复“重发”继续发送剩余成品。'
    state.update(state='idle', stage='delivery_failed', delivery_state='failed', progress_text=message)
    if final is not None:
        final.update(text=message, complete=True)
    return True
