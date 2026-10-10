from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path


class WorkbenchError(ValueError):
    """A user-visible, bounded domain error; never a successful tool result."""


@dataclass(frozen=True)
class Config:
    root: Path
    workspace_id: str = "teacher"
    import_roots: tuple[Path, ...] = field(default_factory=tuple)
    speech_url: str | None = None
    speech_client: Path | None = None
    hermes_command: Path | None = None
    courseware_profile: str | None = None
    courseware_uid: int | None = None
    max_file_bytes: int = 1024 * 1024 * 1024
    max_attempts: int = 3
    lease_seconds: int = 300

    @classmethod
    def load(cls, root: Path | None = None, home: Path | None = None) -> "Config":
        home = Path(home or os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
        settings = home / "teacher-workbench.json"
        raw = json.loads(settings.read_text(encoding="utf-8")) if settings.is_file() else {}
        data_root = Path(root or raw.get("data_root", home / "plugin-data" / "teacher-workbench")).resolve()
        return cls(
            root=data_root,
            workspace_id=raw.get("workspace_id", "teacher"),
            import_roots=tuple(Path(p).resolve() for p in raw.get("import_roots", [str(data_root / "inbox")])),
            speech_url=raw.get("speech_url"),
            speech_client=Path(raw["speech_client"]) if raw.get("speech_client") else None,
            hermes_command=Path(raw["hermes_command"]) if raw.get("hermes_command") else None,
            courseware_profile=raw.get("courseware_profile"),
            courseware_uid=int(raw["courseware_uid"]) if raw.get("courseware_uid") is not None else None,
            max_file_bytes=int(raw.get("max_file_bytes", 1024 * 1024 * 1024)),
            max_attempts=int(raw.get("max_attempts", 3)),
            lease_seconds=int(raw.get("lease_seconds", 300)),
        )

    def input_file(self, value: str) -> Path:
        try:
            path = Path(value).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise WorkbenchError("资料文件不存在或不能访问") from exc
        roots = (*self.import_roots, self.root / "drafts")
        if not any(path.is_relative_to(p.resolve()) for p in roots):
            raise WorkbenchError("资料路径超出教师导入目录；请先放入教师 inbox")
        if not path.is_file():
            raise WorkbenchError("资料必须是普通文件")
        if path.stat().st_size > self.max_file_bytes:
            raise WorkbenchError("资料超过配置的大小上限")
        return path

    def stored_file(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root.resolve()):
            raise WorkbenchError("资料引用越界")
        return path
