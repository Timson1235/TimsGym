"""Typed configuration, loaded from the project's .env (one level up)."""
from urllib.parse import quote_plus

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Read the SAME .env the Node app uses (backend/ runs one level below it).
    model_config = SettingsConfigDict(env_file="../.env", extra="ignore")

    SQL_HOST: str = ""
    SQL_USER: str = ""
    SQL_PASSWORD: str = ""
    SQL_DB_NAME: str = ""
    FIREBASE_PROJECT_ID: str = "fitki-505410"
    # Private beta: Firebase UID is a stable identifier, not a credential.
    APP_ALLOWED_UID: str = "30GTsmJWxpSVCSNwONCmz26dGE53"
    TRACE_ADMIN_UID: str = "30GTsmJWxpSVCSNwONCmz26dGE53"
    CLAUDE_API_KEY: str = ""
    CLAUDE_MODEL: str = "claude-sonnet-5-5"
    CLAUDE_PROMPT_CACHING: bool = True
    CLAUDE_TIMEOUT_SECONDS: float = 45.0
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.8-flash"
    GEMINI_FALLBACK_MODEL: str = "gemini-3.7-flash"
    GEMINI_LAST_RESORT_MODEL: str = "gemini-2.5-flash"
    # Legacy compatibility flag. Payloads are now stored in private traces,
    # never printed to the console.
    AI_DEBUG_PROMPTS: bool = False
    SUMMARY_WORKER_ENABLED: bool = True
    SUMMARY_TIMEOUT_SECONDS: float = 45.0

    @property
    def database_url(self) -> str:
        """SQLAlchemy URL for Neon (SSL required)."""
        pwd = quote_plus(self.SQL_PASSWORD)
        return (
            f"postgresql+psycopg2://{self.SQL_USER}:{pwd}"
            f"@{self.SQL_HOST}/{self.SQL_DB_NAME}?sslmode=require"
        )


settings = Settings()
