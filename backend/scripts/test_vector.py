"""Validate the vector path: embed -> insert -> similarity search -> cleanup."""
import sys
sys.path.insert(0, ".")

from sqlalchemy import text
from sqlmodel import Session

from app.db import engine
from app.memory.store import embed, to_vec_literal

docs = [
    "Progressive overload means gradually increasing weight over time.",
    "Deload weeks reduce fatigue by lowering training volume.",
    "Protein intake supports muscle protein synthesis after training.",
]

with Session(engine) as s:
    for d in docs:
        v = embed(d)
        s.exec(text("INSERT INTO knowledge_base (user_id, content, embedding) "
                    "VALUES (:uid, :c, (:emb)::vector)"),
               params={"uid": 1, "c": d, "emb": to_vec_literal(v)})
    s.commit()

    q = embed("how do I keep getting stronger each week?")
    rows = s.exec(text(
        "SELECT content, embedding <=> (:qv)::vector AS dist "
        "FROM knowledge_base WHERE user_id=1 ORDER BY dist LIMIT 3"
    ), params={"qv": to_vec_literal(q)}).all()
    print("nearest matches to 'keep getting stronger':")
    for content, dist in rows:
        print(f"  {dist:.3f}  {content}")

    s.exec(text("DELETE FROM knowledge_base WHERE user_id=1"))
    s.commit()
    print("cleaned up")
