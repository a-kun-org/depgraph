# Layer violation demo: infra depends on handlers (should be forbidden)
from handlers.user_handler import handle


def get_connection():
    _ = handle
    return {"ok": True}
