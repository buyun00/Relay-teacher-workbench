"""Load native plugins before the installed Hermes one-shot tool snapshot.

The September 2026 host's fast -z path can validate plugin toolsets before
discovery. This entry uses supported APIs and never modifies Hermes core.
Interactive sessions also use the same entry so the tool surface is consistent.
"""
from __future__ import annotations


def main():
    from hermes_cli.plugins import discover_plugins
    discover_plugins()
    from hermes_cli.main import main as hermes_main
    hermes_main()


if __name__ == "__main__":
    main()
