"""Firebase authentication — verify the client's ID token, then map it to a
DB user (creating one on first login). Mirrors server.ts getUserFromRequest.

We verify with google-auth directly (public-cert signature check + audience),
NOT firebase-admin: the Python admin SDK demands a service-account credential
just to verify a token, whereas this only needs the project ID — same as Node.
"""
import logging

from fastapi import Depends, Header, HTTPException
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlmodel import Session

from . import crud
from .config import settings
from .db import get_session

log = logging.getLogger("uvicorn.error")
_google_request = google_requests.Request()


def current_user(
    authorization: str = Header(default=None),
    session: Session = Depends(get_session),
):
    if not authorization or not authorization.startswith("Bearer "):
        log.warning("AUTH: request had NO bearer token (guest, or token not attached)")
        raise HTTPException(status_code=401, detail="Unauthorized: missing token")

    token = authorization.split("Bearer ", 1)[1]
    try:
        claims = google_id_token.verify_firebase_token(
            token, _google_request, audience=settings.FIREBASE_PROJECT_ID,
            clock_skew_in_seconds=10,  # tolerate minor local clock drift
        )
        if not claims:
            raise ValueError("token failed verification")
        expected_iss = f"https://securetoken.google.com/{settings.FIREBASE_PROJECT_ID}"
        if claims.get("iss") != expected_iss:
            raise ValueError(f"unexpected issuer: {claims.get('iss')}")
    except Exception as e:
        log.warning("AUTH: verify FAILED -> %s: %s", type(e).__name__, e)
        raise HTTPException(status_code=401, detail="Unauthorized: invalid token")

    uid = claims.get("user_id") or claims.get("sub")
    email = claims.get("email") or f"{uid}@user.com"
    name = claims.get("name")
    log.info("AUTH: verified uid=%s email=%s", uid, email)
    return crud.get_or_create_user(session, uid, email, name)
