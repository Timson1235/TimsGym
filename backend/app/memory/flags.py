"""Per-memory-type feature flags. Toggle any type on/off via env (MEM_*) so we
only pay the latency of what's enabled. Defaults: the cheap, high-value types
on; the vector-heavy playground types off.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class MemoryFlags(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MEM_", env_file="../.env", extra="ignore")

    conversational: bool = True   # multi-turn continuity (cheap, SQL)
    summary: bool = True          # auto-summarization (adds an LLM call on offload)
    tool_log: bool = True         # audit of tool calls (cheap, SQL)
    knowledge_base: bool = False  # vector: fitness content
    workflow: bool = False        # vector: past tool sequences
    entity: bool = False          # vector + extra LLM call per turn
    toolbox: bool = False         # vector: semantic tool search (pointless at 7 tools)


flags = MemoryFlags()
