"""Vector store helpers: Gemini embeddings + pgvector formatting.

We use exact KNN (no ANN index) — fine at a personal app's scale, and it sidesteps
pgvector's 2000-dim index limit (gemini-embedding-001 is 3072-dim).
"""
from typing import Optional

from google import genai

from ..config import settings

EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 3072

_client: Optional[genai.Client] = None
if settings.GEMINI_API_KEY:
    _client = genai.Client(api_key=settings.GEMINI_API_KEY)


def embed(text: str) -> Optional[list[float]]:
    """Embed text with Gemini. Returns None if AI is unconfigured or text is empty."""
    if _client is None or not (text or "").strip():
        return None
    r = _client.models.embed_content(model=EMBED_MODEL, contents=text)
    return list(r.embeddings[0].values)


def to_vec_literal(vec: list[float]) -> str:
    """pgvector text form: '[0.1,0.2,...]'. Bind as a param and cast with ::vector."""
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"
