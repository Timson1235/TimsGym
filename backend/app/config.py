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
    GEMINI_API_KEY: str = ""

    @property
    def database_url(self) -> str:
        """SQLAlchemy URL for Neon (SSL required)."""
        pwd = quote_plus(self.SQL_PASSWORD)
        return (
            f"postgresql+psycopg2://{self.SQL_USER}:{pwd}"
            f"@{self.SQL_HOST}/{self.SQL_DB_NAME}?sslmode=require"
        )


settings = Settings()
