from domain.models import User
from infra.db import get_connection


def handle(event, context):
    conn = get_connection()
    return {"user": User(id="1").to_dict(), "db": bool(conn)}
