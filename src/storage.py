"""SQLite persistence for threads and messages."""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_CONN: sqlite3.Connection | None = None
_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_title(title: str | None) -> str | None:
    if title is None:
        return None
    normalized = title.strip()
    return normalized or None


def init_db(db_path: str | Path) -> None:
    """Initialize SQLite DB and create schema if it does not exist."""
    global _CONN
    path = str(db_path)
    _CONN = sqlite3.connect(path, check_same_thread=False)
    _CONN.row_factory = sqlite3.Row

    with _LOCK:
        _CONN.execute("PRAGMA journal_mode=WAL;")
        _CONN.execute("PRAGMA foreign_keys=ON;")
        _CONN.execute(
            """
            CREATE TABLE IF NOT EXISTS threads(
                id TEXT PRIMARY KEY,
                title TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT NULL
            )
            """
        )
        _CONN.execute(
            """
            CREATE TABLE IF NOT EXISTS messages(
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                role TEXT NOT NULL,
                transcription TEXT NULL,
                content TEXT NOT NULL,
                llm_time REAL NULL,
                tts_time REAL NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(thread_id) REFERENCES threads(id)
            )
            """
        )
        _CONN.commit()


def _conn() -> sqlite3.Connection:
    if _CONN is None:
        raise RuntimeError("Database not initialized")
    return _CONN


def ensure_thread(thread_id: str, title: str | None = None) -> None:
    normalized_title = normalize_title(title)
    ts = now_iso()
    with _LOCK:
        _conn().execute(
            """
            INSERT OR IGNORE INTO threads(id, title, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, NULL)
            """,
            (thread_id, normalized_title, ts, ts),
        )
        _conn().execute(
            "UPDATE threads SET updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            (ts, thread_id),
        )
        _conn().commit()


def create_thread(*, thread_id: str, title: str | None = None) -> dict[str, Any]:
    normalized_title = normalize_title(title)
    ts = now_iso()
    with _LOCK:
        _conn().execute(
            """
            INSERT INTO threads(id, title, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, NULL)
            """,
            (thread_id, normalized_title, ts, ts),
        )
        _conn().commit()
    return get_thread(thread_id)


def get_thread(thread_id: str, *, include_deleted: bool = False) -> dict[str, Any] | None:
    query = """
        SELECT id, title, created_at, updated_at, deleted_at
        FROM threads
        WHERE id = ?
    """
    params: tuple[Any, ...] = (thread_id,)
    if not include_deleted:
        query += " AND deleted_at IS NULL"
    with _LOCK:
        row = _conn().execute(query, params).fetchone()
    return dict(row) if row else None


def update_thread_title(thread_id: str, title: str | None) -> dict[str, Any] | None:
    normalized_title = normalize_title(title)
    if normalized_title is None:
        return get_thread(thread_id)

    ts = now_iso()
    with _LOCK:
        cursor = _conn().execute(
            """
            UPDATE threads
            SET title = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
            """,
            (normalized_title, ts, thread_id),
        )
        _conn().commit()

    if cursor.rowcount == 0:
        return None
    return get_thread(thread_id)


def soft_delete_thread(thread_id: str) -> bool:
    ts = now_iso()
    with _LOCK:
        cursor = _conn().execute(
            """
            UPDATE threads
            SET deleted_at = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
            """,
            (ts, ts, thread_id),
        )
        _conn().commit()
    return cursor.rowcount > 0


def insert_message(
    *,
    message_id: str,
    thread_id: str,
    role: str,
    content: str,
    transcription: str | None = None,
    llm_time: float | None = None,
    tts_time: float | None = None,
    created_at: str | None = None,
) -> None:
    ts = created_at or now_iso()
    with _LOCK:
        _conn().execute(
            """
            INSERT INTO messages(id, thread_id, role, transcription, content, llm_time, tts_time, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (message_id, thread_id, role, transcription, content, llm_time, tts_time, ts),
        )
        _conn().execute(
            "UPDATE threads SET updated_at = ? WHERE id = ?",
            (ts, thread_id),
        )
        _conn().commit()


def list_threads() -> list[dict[str, Any]]:
    with _LOCK:
        rows = _conn().execute(
            """
            SELECT id, title, created_at, updated_at, deleted_at
            FROM threads
            WHERE deleted_at IS NULL
            ORDER BY updated_at DESC, created_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def thread_exists(thread_id: str) -> bool:
    return get_thread(thread_id) is not None


def list_messages(thread_id: str) -> list[dict[str, Any]]:
    with _LOCK:
        rows = _conn().execute(
            """
            SELECT id, thread_id, role, transcription, content, llm_time, tts_time, created_at
            FROM messages
            WHERE thread_id = ?
            ORDER BY created_at ASC
            """,
            (thread_id,),
        ).fetchall()
    return [dict(row) for row in rows]
