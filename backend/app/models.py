"""SQLModel table models mirroring the existing Drizzle-created tables.

Attribute names are snake_case to match the DB columns. The API layer
(crud.py) converts to the camelCase shapes the React frontend expects.
"""
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import JSON, TIMESTAMP, Column, func
from sqlmodel import Field, SQLModel


class User(SQLModel, table=True):
    __tablename__ = "users"
    id: Optional[int] = Field(default=None, primary_key=True)
    uid: str
    email: str
    created_at: Optional[datetime] = None


class Profile(SQLModel, table=True):
    __tablename__ = "profiles"
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int
    name: str = "Athlete"
    preferred_unit: str = "kg"
    experience_level: str = "Intermediate"
    primary_goal: str = "Hypertrophy"
    personal_memories: Optional[list] = Field(default=None, sa_column=Column(JSON))
    notes: Optional[str] = None


class Exercise(SQLModel, table=True):
    __tablename__ = "exercises"
    id: str = Field(primary_key=True)
    user_id: Optional[int] = None
    name: str
    category: str
    equipment: str
    instructions: Optional[str] = None
    is_custom: Optional[bool] = False
    personal_record: Optional[dict[str, Any]] = Field(default=None, sa_column=Column(JSON))


class Workout(SQLModel, table=True):
    __tablename__ = "workouts"
    id: str = Field(primary_key=True)
    user_id: int
    title: str
    date: str
    duration_minutes: int = 0
    total_volume: int = 0
    is_completed: Optional[bool] = True
    notes: Optional[str] = None
    exercises_data: Optional[list] = Field(default=None, sa_column=Column(JSON))
    created_at: Optional[datetime] = None


# ---- Phase 2b: memory subsystem (non-vector tables) ----

class Message(SQLModel, table=True):
    """Conversational memory — one row per chat turn (user/assistant)."""
    __tablename__ = "messages"
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int
    thread_id: str = "default"
    role: str  # 'user' | 'assistant'
    content: str
    summary_id: Optional[str] = None  # set once summarized -> excluded from active context
    created_at: Optional[datetime] = Field(
        default=None, sa_column=Column(TIMESTAMP(timezone=True), server_default=func.now()))


class ChatSession(SQLModel, table=True):
    """A user-visible AI conversation, similar to a ChatGPT chat."""
    __tablename__ = "chat_sessions"
    id: str = Field(primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True)
    title: str = "New chat"
    created_at: Optional[datetime] = Field(
        default=None, sa_column=Column(TIMESTAMP(timezone=True), server_default=func.now()))
    updated_at: Optional[datetime] = Field(
        default=None, sa_column=Column(TIMESTAMP(timezone=True), server_default=func.now()))


class ConversationSummary(SQLModel, table=True):
    """Existing summaries table; the unused nullable embedding column is omitted."""
    __tablename__ = "summaries"
    id: str = Field(primary_key=True)
    user_id: int = Field(index=True)
    thread_id: str
    description: str
    summary_text: str
    full_content: str
    created_at: Optional[datetime] = Field(
        default=None, sa_column=Column(TIMESTAMP(timezone=True), server_default=func.now()))


class SummaryJob(SQLModel, table=True):
    """One durable, coalesced summary checkpoint and lease per account/chat."""
    __tablename__ = "summary_jobs"
    id: str = Field(primary_key=True)
    user_id: int = Field(index=True)
    thread_id: str
    requested_through_id: int = 0
    completed_through_id: int = 0
    summary_id: Optional[str] = None
    status: str = Field(default="pending", index=True)
    attempts: int = 0
    available_at: float = 0
    lease_until: float = 0
    lease_token: Optional[str] = None
    last_error_type: Optional[str] = None
    last_usage: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    completed_at: Optional[float] = None


class ToolLog(SQLModel, table=True):
    """Audit log of every tool call the agent makes."""
    __tablename__ = "tool_logs"
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int
    thread_id: str = "default"
    tool_name: str
    tool_args: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    result: Optional[str] = None
    status: str = "success"
    error_message: Optional[str] = None
    created_at: Optional[datetime] = Field(
        default=None, sa_column=Column(TIMESTAMP(timezone=True), server_default=func.now()))


class AIRequestMetric(SQLModel, table=True):
    """Sanitized per-request AI performance telemetry, scoped to one user."""
    __tablename__ = "ai_request_metrics"
    id: Optional[int] = Field(default=None, primary_key=True)
    request_id: str = Field(index=True, unique=True)
    user_id: int = Field(foreign_key="users.id", index=True)
    thread_id: str = Field(default="default", index=True)
    status: str = "success"
    provider: Optional[str] = None
    model: Optional[str] = None
    total_ms: int = 0
    round_trip_ms: Optional[int] = None
    agent_steps: int = 0
    model_ms: int = 0
    tool_ms: int = 0
    context_ms: int = 0
    persistence_ms: int = 0
    slowest_step_name: Optional[str] = None
    slowest_step_kind: Optional[str] = None
    slowest_step_ms: Optional[int] = None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    tools_used: Optional[list] = Field(default=None, sa_column=Column(JSON))
    steps: Optional[list] = Field(default=None, sa_column=Column(JSON))
    error_type: Optional[str] = None
    created_at: Optional[datetime] = Field(
        default=None, sa_column=Column(TIMESTAMP(timezone=True), server_default=func.now()))


class AgentTrace(SQLModel, table=True):
    __tablename__ = 'agent_traces'
    id: str = Field(primary_key=True)
    user_id: int = Field(index=True)
    thread_id: str = Field(index=True)
    parent_trace_id: Optional[str] = Field(default=None, index=True)
    kind: str = 'chat'
    name: str = 'Coach request'
    version: int = 1
    status: str = Field(default='running', index=True)
    started_at: float
    ended_at: Optional[float] = None
    error_type: Optional[str] = None


class AgentSpan(SQLModel, table=True):
    __tablename__ = 'agent_spans'
    id: str = Field(primary_key=True)
    trace_id: str = Field(index=True)
    parent_span_id: Optional[str] = None
    sequence: int
    kind: str
    name: str
    status: str = 'running'
    started_at: float
    ended_at: Optional[float] = None
    input_payload_id: Optional[str] = None
    output_payload_id: Optional[str] = None
    error_type: Optional[str] = None


class AgentTracePayload(SQLModel, table=True):
    __tablename__ = 'agent_trace_payloads'
    id: str = Field(primary_key=True)
    trace_id: str = Field(index=True)
    data: Any = Field(sa_column=Column(JSON, nullable=False))
