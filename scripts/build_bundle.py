"""Build a code-only archive; runtime data and credentials can never enter it."""
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parents[1]
output = root / "dist" / "plugin.tar.gz"
output.parent.mkdir(exist_ok=True)
files = [root / name for name in ["__init__.py", "plugin.yaml", "AGENTS.md", "README.md"]]
for folder in ["workbench", "skills", "tests", "config", "docs"]:
    files.extend(p for p in (root / folder).rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
with tarfile.open(output, "w:gz") as archive:
    for path in sorted(files):
        archive.add(path, arcname=path.relative_to(root), recursive=False)
print(output)
