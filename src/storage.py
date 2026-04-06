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
    ts = now_iso()
    with _LOCK:
        _conn().execute(
            """
            INSERT OR IGNORE INTO threads(id, title, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, NULL)
            """,
            (thread_id, title, ts, ts),
        )
        _conn().execute(
            "UPDATE threads SET updated_at = ? WHERE id = ?",
            (ts, thread_id),
        )
        _conn().commit()


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
    with _LOCK:
        row = _conn().execute(
            "SELECT 1 FROM threads WHERE id = ? AND deleted_at IS NULL",
            (thread_id,),
        ).fetchone()
    return row is not None


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
