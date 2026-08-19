"""Find a working Gemini embedding model + its output dimension."""
import sys
sys.path.insert(0, ".")

from google import genai

from app.config import settings

client = genai.Client(api_key=settings.GEMINI_API_KEY)

for model in ["text-embedding-004", "gemini-embedding-001", "text-embedding-005"]:
    try:
        r = client.models.embed_content(model=model, contents="bench press progressive overload")
        print(f"OK   {model}  -> dim {len(r.embeddings[0].values)}")
    except Exception as e:
        print(f"FAIL {model}  -> {str(e)[:90]}")
