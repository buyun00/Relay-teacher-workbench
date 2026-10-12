from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


class WorkbenchError(ValueError):
    """A user-visible, bounded domain error; never a successful tool result."""


@dataclass(frozen=True)
class Config:
    root: Path
    workspace_id: str = "teacher"
    speech_url: str | None = None
    speech_client: Path | None = None
    hermes_command: Path | None = None
    courseware_profile: str | None = None
    max_attempts: int = 3
    lease_seconds: int = 300
    auto_process_recordings: bool = False
    profile_home: Path | None = None

    @classmethod
    def load(cls, root: Path | None = None, home: Path | None = None) -> "Config":
        home = Path(home or os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
        settings = home / "teacher-workbench.json"
        raw = json.loads(settings.read_text(encoding="utf-8")) if settings.is_file() else {}
        data_root = Path(root or raw.get("data_root", home / "plugin-data" / "teacher-workbench")).resolve()
        return cls(
            root=data_root,
            workspace_id=raw.get("workspace_id", "teacher"),
            speech_url=raw.get("speech_url"),
            speech_client=Path(raw["speech_client"]) if raw.get("speech_client") else None,
            hermes_command=Path(raw["hermes_command"]) if raw.get("hermes_command") else None,
            courseware_profile=raw.get("courseware_profile"),
            max_attempts=int(raw.get("max_attempts", 3)),
            lease_seconds=int(raw.get("lease_seconds", 300)),
            auto_process_recordings=bool(raw.get("auto_process_recordings", False)),
            profile_home=home.resolve(),
        )

    def input_file(self, value: str) -> Path:
        try:
            path = Path(value).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise WorkbenchError("资料文件不存在或不能访问") from exc
        if not path.is_file():
            raise WorkbenchError("资料必须是普通文件")
        return path

    def stored_file(self, relative: str) -> Path:
        return (self.root / relative).resolve()
