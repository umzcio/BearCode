"""Durable idempotency records for accepted BearCode turns."""
import os
import sqlite3
import stat
import threading
import time
from dataclasses import dataclass
from pathlib import Path


_TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
_RETENTION_SECONDS = 7 * 24 * 60 * 60
_MAX_ROWS = 1024


@dataclass(frozen=True)
class TurnRecord:
    turn_id: str
    conversation_id: str
    status: str
    accepted_at: int
    updated_at: int


class TurnLedger:
    """SQLite-backed record of turns that may never be executed twice."""

    def __init__(self, state_root: Path):
        self.state_root = Path(state_root)
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.state_root, 0o700)
        self.path = self.state_root / "bearcode-turns.sqlite3"
        self._create_restricted_file()
        self._connection = sqlite3.connect(
            str(self.path),
            isolation_level=None,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS bearcode_turns (
                  turn_id TEXT PRIMARY KEY,
                  conversation_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  accepted_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                )
                """
            )
            self._prune_locked(int(time.time()))

    def _create_restricted_file(self):
        flags = os.O_CREAT | os.O_EXCL | os.O_RDWR
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(str(self.path), flags, 0o600)
        except FileExistsError:
            file_stat = os.stat(self.path, follow_symlinks=False)
            if not stat.S_ISREG(file_stat.st_mode):
                raise ValueError("turn ledger must be a regular file")
        else:
            os.close(descriptor)
        os.chmod(self.path, 0o600, follow_symlinks=False)

    @staticmethod
    def _record(row):
        if row is None:
            return None
        return TurnRecord(
            turn_id=row["turn_id"],
            conversation_id=row["conversation_id"],
            status=row["status"],
            accepted_at=row["accepted_at"],
            updated_at=row["updated_at"],
        )

    def get(self, turn_id):
        with self._lock:
            row = self._connection.execute(
                """
                SELECT turn_id, conversation_id, status, accepted_at, updated_at
                FROM bearcode_turns
                WHERE turn_id = ?
                """,
                (str(turn_id),),
            ).fetchone()
            return self._record(row)

    def accept(self, turn_id, conversation_id):
        """Atomically accept a turn or return its existing durable record."""
        turn_id_text = str(turn_id)
        conversation_id_text = str(conversation_id)
        now = int(time.time())
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._connection.execute(
                    """
                    SELECT turn_id, conversation_id, status,
                           accepted_at, updated_at
                    FROM bearcode_turns
                    WHERE turn_id = ?
                    """,
                    (turn_id_text,),
                ).fetchone()
                if row is not None:
                    record = self._record(row)
                    if record.conversation_id != conversation_id_text:
                        raise ValueError(
                            "turnId belongs to another conversation"
                        )
                    self._connection.execute("COMMIT")
                    return False, record

                self._connection.execute(
                    """
                    INSERT INTO bearcode_turns (
                      turn_id, conversation_id, status, accepted_at, updated_at
                    ) VALUES (?, ?, 'accepted', ?, ?)
                    """,
                    (turn_id_text, conversation_id_text, now, now),
                )
                self._prune_locked(now)
                self._connection.execute("COMMIT")
                return True, TurnRecord(
                    turn_id=turn_id_text,
                    conversation_id=conversation_id_text,
                    status="accepted",
                    accepted_at=now,
                    updated_at=now,
                )
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def mark_terminal(self, turn_id, status):
        if status not in _TERMINAL_STATUSES:
            raise ValueError("invalid terminal turn status")
        now = int(time.time())
        with self._lock:
            cursor = self._connection.execute(
                """
                UPDATE bearcode_turns
                SET status = ?, updated_at = ?
                WHERE turn_id = ?
                """,
                (status, now, str(turn_id)),
            )
            if cursor.rowcount != 1:
                raise ValueError("turn is not accepted")
            self._prune_locked(now)

    def prune(self, now=None):
        current = int(time.time()) if now is None else int(now)
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                self._prune_locked(current)
                self._connection.execute("COMMIT")
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def _prune_locked(self, now):
        cutoff = now - _RETENTION_SECONDS
        terminal_placeholders = ",".join("?" for _ in _TERMINAL_STATUSES)
        self._connection.execute(
            """
            DELETE FROM bearcode_turns
            WHERE updated_at < ?
              AND status IN ({})
            """.format(terminal_placeholders),
            (cutoff, *_TERMINAL_STATUSES),
        )
        row_count = self._connection.execute(
            "SELECT COUNT(*) FROM bearcode_turns"
        ).fetchone()[0]
        excess = row_count - _MAX_ROWS
        if excess <= 0:
            return
        self._connection.execute(
            """
            DELETE FROM bearcode_turns
            WHERE turn_id IN (
              SELECT turn_id
              FROM bearcode_turns
              ORDER BY
                CASE WHEN status = 'accepted' THEN 1 ELSE 0 END,
                updated_at ASC,
                accepted_at ASC,
                turn_id ASC
              LIMIT ?
            )
            """,
            (excess,),
        )

    def close(self):
        with self._lock:
            connection = self._connection
            self._connection = None
            if connection is not None:
                connection.close()
