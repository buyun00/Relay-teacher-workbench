"""Install the DingTalk task hook into the existing plugin, not Hermes core.

Default is a read-only compatibility check. --apply requires a quiescent old
router; no service restart, credentials or desktop files are touched.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import time


def prepare(router, source):
    path = router / '__init__.py'
    body = path.read_text(encoding='utf-8')
    marker = '    # teacher-workbench: isolated DingTalk task routing\n'
    anchor = '    key = identity(source)\n    async with LOCKS.setdefault(key, asyncio.Lock()):'
    insertion = (marker + "    if source.platform.value == 'dingtalk':\n"
                 '        from . import gateway_tasks\n'
                 '        return await gateway_tasks.route(SimpleNamespace(**globals()), event, gateway)\n')
    if marker not in body:
        if body.count(anchor) != 1 or 'GATEWAY = gateway\n' not in body:
            raise RuntimeError('钉钉入口已变化，请先核对线上插件；未写入任何文件')
        body = body.replace(anchor, insertion + anchor, 1)
    elif insertion not in body:
        raise RuntimeError('已有任务入口版本不同，请先审查')
    # /tasks must reach the new layer; keep other native commands unchanged.
    body = body.replace("command not in ('/new', '/reset'):", "command not in ('/new', '/reset', '/tasks'):")
    courseware = (router / 'main_courseware.py').read_text(encoding='utf-8')
    if 'DELIVERY.file_receipt' not in courseware or 'DELIVERY.watch' not in courseware:
        raise RuntimeError('必须先安装已验证的原对话文件交付扩展；不能以无回执发送冒充交付')
    if 'teaching_video' not in body:
        raise RuntimeError('现有插件尚未包含教学视频路由，不能覆盖旧版本')
    changes = {'__init__.py': body}
    for name in ('gateway_tasks.py', 'gateway_task_runner.py'):
        changes[name] = (source / name).read_text(encoding='utf-8')
    for name, content in changes.items():
        compile(content, str(router / name), 'exec')
    return changes


def install(router, source):
    changes = prepare(router, source)
    if '# teacher-workbench: isolated DingTalk task routing' not in (router / '__init__.py').read_text(encoding='utf-8'):
        for state_file in (router.parent.parent / 'native-classroom').glob('native_*/state.json'):
            state = json.loads(state_file.read_text(encoding='utf-8'))
            if state.get('state') in {'active', 'delivering'}:
                raise RuntimeError('旧制作任务仍在运行或发送；首次接入需等待其完成，不打断或重复提交')
    backup = router.parent.parent / 'teacher-plugin-backups' / ('task-routing-' + time.strftime('%Y%m%dT%H%M%S'))
    backup.mkdir(parents=True, exist_ok=False)
    written = []
    try:
        for name, content in changes.items():
            target = router / name
            if target.exists():
                shutil.copy2(target, backup / name)
            temporary = target.with_name(name + '.task-routing-tmp')
            temporary.write_text(content, encoding='utf-8')
            template = target if target.exists() else router / '__init__.py'
            shutil.copymode(template, temporary)
            if os.name == 'posix':
                owner = template.stat()
                os.chown(temporary, owner.st_uid, owner.st_gid)
            temporary.replace(target)
            written.append(name)
    except BaseException:
        for name in reversed(written):
            original = backup / name
            if original.exists():
                shutil.copy2(original, router / name)
            else:
                (router / name).unlink()
        raise
    return backup


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--router', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1] / 'workbench')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply:
        print('PLUGIN_BACKUP', install(args.router, args.source))
    else:
        print('COMPATIBLE', ', '.join(prepare(args.router, args.source)))
