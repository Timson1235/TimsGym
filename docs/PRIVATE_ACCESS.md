# Owner-only application access

The current private-beta owner is Firebase UID `30GTsmJWxpSVCSNwONCmz26dGE53`. The identifier is not a credential. A valid, signed Firebase ID token for that exact subject is required.

## Server boundary

[auth.py](/Users/tim/Work/TimsGym/backend/app/auth.py) verifies the token signature/project audience/issuer, then compares its canonical `sub` with `APP_ALLOWED_UID` before creating or loading a database user. Missing/invalid tokens return 401; verified other accounts return 403 before workout, chat, model or trace operations. Mismatched `user_id`/`sub` claims are rejected. Client-supplied UIDs, email addresses and UI visibility never authorize access.

```python
uid = claims.get("sub")
if not isinstance(uid, str) or not uid or claims.get("user_id", uid) != uid:
    raise HTTPException(status_code=401, detail="Unauthorized: invalid identity")
if not settings.APP_ALLOWED_UID or uid != settings.APP_ALLOWED_UID:
    raise HTTPException(status_code=403, detail="This app is currently restricted to its owner.")
```

Trace list, detail, payload and export endpoints additionally use `Depends(trace_admin)` in [routers/ai.py](/Users/tim/Work/TimsGym/backend/app/routers/ai.py). The trace administrator must match both application owner and `TRACE_ADMIN_UID`. Existing ownership checks still limit traces to that account.

[config.py](/Users/tim/Work/TimsGym/backend/app/config.py) and [.env.example](/Users/tim/Work/TimsGym/.env.example) configure both policies to the supplied UID by default, so the committed deployment is restricted without requiring a new environment variable. Deployment environment variables can override these settings. Explicitly empty settings deny access rather than granting public access.

```dotenv
APP_ALLOWED_UID="30GTsmJWxpSVCSNwONCmz26dGE53"
TRACE_ADMIN_UID="30GTsmJWxpSVCSNwONCmz26dGE53"
```

The production Docker entry point uses FastAPI. [server.ts](/Users/tim/Work/TimsGym/server.ts) also guards the legacy Node `/api` entry point with the same owner policy. Only the public health endpoint is exempt. That legacy runtime does not offer execution tracing and reports `canInspectTraces: false`.

## Client behavior

[main.py](/Users/tim/Work/TimsGym/backend/app/main.py) exposes authenticated `/api/access`, returning `canUseApp` and `canInspectTraces`, with no-store caching. [api.ts](/Users/tim/Work/TimsGym/src/lib/api.ts) fetches these permissions using the Firebase token.

[App.tsx](/Users/tim/Work/TimsGym/src/App.tsx) checks server permissions before loading cloud data, showing a workout or restoring its draft. Guest entry is disabled. Account changes clear rendered account data immediately, and an authentication-request revision prevents an older request from installing data after an account switch. Denied accounts see a private-access message and can sign out; failed verification offers retry.

```tsx
const permission = await fetchAppAccess();
if (request !== revision) return;
if (!permission.canUseApp) throw new Error('This app is currently private.');
setAccess(permission);
const data = await fetchDatabase();
```

[Navbar.tsx](/Users/tim/Work/TimsGym/src/components/Navbar.tsx) shows the trace link only when the server grants trace inspection. Direct navigation to the viewer also checks this permission. [LoginScreen.tsx](/Users/tim/Work/TimsGym/src/components/LoginScreen.tsx) describes private-beta access and receives no guest-continue action from the application.

The login shell, static assets and health endpoint remain public; private APIs require authorization. Existing user records are not deleted. Previously downloaded client code cannot be remotely erased; it does not bypass the server authorization checks. Development-only synthetic test fixtures do not access real account data.

## Verification

[test_private_access.py](/Users/tim/Work/TimsGym/backend/tests/test_private_access.py) tests allowed owner access, other-account denial across read/write/streaming/trace/export endpoints, denial before user bootstrap or model execution, invalid tokens/issuer/identity, empty app policy and separate administrator policy. Tokens/providers are mocked; no real credentials or private traces are inspected.

[test_execution_traces.py](/Users/tim/Work/TimsGym/backend/tests/test_execution_traces.py) retains trace ownership/export tests under an explicit synthetic administrator policy.
