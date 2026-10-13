"""Update only the existing smart-chat-router plugin; never edit Hermes core."""
from __future__ import annotations

import argparse
import shutil
import time
from pathlib import Path


def replace_once(body, old, new):
    if new in body:
        return body
    if body.count(old) != 1:
        raise RuntimeError('Installed router changed; inspect the plugin before updating: ' + old[:80])
    return body.replace(old, new, 1)


def prepare(router, source):
    init = (router / '__init__.py').read_text(encoding='utf-8')
    init = replace_once(init, 'def register(ctx):\n', 'from . import gateway_delivery as DELIVERY\n\n\ndef register(ctx):\n')
    init = replace_once(init, "    ctx.register_hook('pre_gateway_dispatch', route)",
                        "    ctx.register_hook('pre_gateway_dispatch', route)\n    DELIVERY.register(ctx)")
    init = replace_once(init, '        adapter = gateway._delivery_adapter_for(source)\n        chat =',
                        "        adapter = gateway._delivery_adapter_for(source)\n        if source.platform.value == 'dingtalk':\n            DELIVERY.enable_file_delivery(adapter, event, COURSEWARE.send_file)\n        chat =")
    main = (router / 'main_courseware.py').read_text(encoding='utf-8')
    main = replace_once(main, 'from .courseware import native_backend as B',
                        'from .courseware import native_backend as B\nfrom . import gateway_delivery as DELIVERY')
    main = replace_once(main, "    if sid and B.load(sid)['state']=='active':",
                        "    if sid and B.load(sid)['state'] in ('active', 'delivering'):")
    main = replace_once(main, "        if r.json().get('errcode',0):raise RuntimeError('File delivery failed')",
                        "        return DELIVERY.file_receipt(r.json(), job['staff'])")
    start, end = main.index('async def watch('), main.index('\nasync def handle(')
    main = main[:start] + ("async def watch(router,adapter,job,sid,turn,key):\n    try:\n"
        "        await DELIVERY.watch(router,adapter,job,sid,turn,key,B)\n    finally:\n        WATCHERS.pop(sid,None)\n") + main[end:]
    main = replace_once(main, "    await B.control('POST',f'/sessions/{sid}/messages',",
                        "    if DELIVERY.retry_requested(B.load(sid), event.text, event.media_urls):\n"
                        "        WATCHERS[sid]=asyncio.create_task(watch(router,adapter,job,sid,B.load(sid)['turn'],key))\n"
                        "        return\n    await B.control('POST',f'/sessions/{sid}/messages',")
    backend = (router / 'courseware/native_backend.py').read_text(encoding='utf-8')
    backend = replace_once(backend, 'if __package__:\n    from . import gpt_tiers as TIERS',
                           'if __package__:\n    from ..delivery_policy import DELIVERY_RULE, recover_delivery_state\n    from . import gpt_tiers as TIERS')
    backend = replace_once(backend, 'else:\n    import gpt_tiers as TIERS',
                           'else:\n    import sys\n    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))\n    from delivery_policy import DELIVERY_RULE, recover_delivery_state\n    import gpt_tiers as TIERS')
    backend = replace_once(backend, "        if s.get('state') == 'active':",
                           "        if s.get('state') == 'delivering':\n"
                           "            existing = RUNNING.get(s['id'])\n"
                           "            if existing is not None and not existing.done():\n                continue\n"
                           "            if recover_delivery_state(s):\n                store(s)\n            continue\n"
                           "        if s.get('state') == 'active':")
    backend = replace_once(backend, "    prompt = (introduction+", "    prompt = (introduction+DELIVERY_RULE+")
    backend = replace_once(backend, "        if s['state'] == 'active':\n            raise ValueError('Hermes 正在制作当前课件",
                           "        if s['state'] in ('active', 'delivering'):\n            raise ValueError('Hermes 正在制作当前课件")
    backend = replace_once(backend, "            s['state'] = 'idle'\n            s['stage'] = 'completed' if succeeded else 'failed'",
                           "            s['state'] = 'delivering'\n            s['stage'] = 'completed' if succeeded else 'failed'")
    backend = replace_once(backend, 'if path.parent != root or path.suffix.lower() not in EXTENSIONS or not path.is_file():',
                           'if not path.is_relative_to(root) or not path.is_file():')
    backend = replace_once(backend, "        for p in (folder(sid) / 'output').iterdir():",
                           "        for p in sorted((folder(sid) / 'output').rglob('*')):")
    backend = replace_once(backend, '            if p.is_file() and p.suffix.lower() in EXTENSIONS and not p.is_symlink():',
                           '            if p.is_file():')
    backend = replace_once(backend, "files.append({'name': p.name, 'size': st.st_size, 'modified': st.st_mtime_ns})",
                           "files.append({'name': str(p.relative_to(folder(sid) / 'output')), 'size': st.st_size, 'modified': st.st_mtime_ns})")
    manifest = (router / 'plugin.yaml').read_text(encoding='utf-8')
    if '  - transform_llm_output' not in manifest:
        manifest += '  - pre_llm_call\n  - transform_llm_output\n  - on_session_end\n'
    manifest = manifest.replace('version: 1.1.0', 'version: 1.1.1')
    changes = {'__init__.py': init, 'main_courseware.py': main,
               'courseware/native_backend.py': backend, 'plugin.yaml': manifest,
               'delivery_policy.py': (source / 'delivery_policy.py').read_text(encoding='utf-8'),
               'gateway_delivery.py': (source / 'gateway_delivery.py').read_text(encoding='utf-8')}
    for name, body in changes.items():
        if name.endswith('.py'):
            compile(body, str(router / name), 'exec')
    return changes


def install(router, source):
    changes = prepare(router, source)
    backup = router.parent.parent / 'teacher-plugin-backups' / ('delivery-' + time.strftime('%Y%m%dT%H%M%S'))
    backup.mkdir(parents=True, exist_ok=False)
    for name, body in changes.items():
        target = router / name
        if target.is_file():
            destination = backup / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, destination)
        temporary = target.with_name(target.name + '.delivery-tmp')
        temporary.write_text(body, encoding='utf-8')
        shutil.copymode(target if target.is_file() else router / '__init__.py', temporary)
        temporary.replace(target)
    return backup


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--router', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1] / 'workbench')
    args = parser.parse_args()
    print('PLUGIN_BACKUP', install(args.router, args.source))
