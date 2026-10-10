"""Native Hermes plugin entry point. No core overrides or extra AI framework."""


def register(ctx):
    from .workbench.native import register_plugin
    register_plugin(ctx)
