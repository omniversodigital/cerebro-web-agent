import sqlite3
import json
import os
import time
from typing import List, Dict, Any, Optional

DB_PATH = os.path.join(os.path.dirname(__file__), "cerebro_agent.db")

class AgentStorage:
    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_db()
        self._migrate_json_files()

    def get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            # Runs Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS agent_runs (
                    run_id TEXT PRIMARY KEY,
                    task TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    steps_json TEXT,
                    metadata_json TEXT
                );
            """)

            # Computer History Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS computer_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT,
                    step_index INTEGER,
                    action_type TEXT,
                    coords TEXT,
                    text_typed TEXT,
                    explanation TEXT,
                    screenshot_path TEXT,
                    timestamp REAL NOT NULL
                );
            """)
            conn.commit()

    def _migrate_json_files(self):
        """Migrate legacy computer_history.json and run_history.json to SQLite if they exist."""
        base_dir = os.path.dirname(self.db_path)
        comp_json = os.path.join(base_dir, "computer_history.json")
        run_json = os.path.join(base_dir, "run_history.json")

        with self.get_connection() as conn:
            cursor = conn.cursor()

            # Migrate computer_history.json
            if os.path.exists(comp_json):
                try:
                    with open(comp_json, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        if isinstance(data, list):
                            for idx, item in enumerate(data):
                                cursor.execute("""
                                    INSERT INTO computer_history 
                                    (run_id, step_index, action_type, coords, text_typed, explanation, screenshot_path, timestamp)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                """, (
                                    item.get("run_id", "legacy"),
                                    item.get("step", idx),
                                    item.get("action"),
                                    json.dumps(item.get("coords")),
                                    item.get("text"),
                                    item.get("explanation", ""),
                                    item.get("screenshot", ""),
                                    time.time()
                                ))
                except Exception as e:
                    print(f"[Storage Migration Error] computer_history.json: {e}")

            # Migrate run_history.json
            if os.path.exists(run_json):
                try:
                    with open(run_json, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        if isinstance(data, dict):
                            for run_id, run_info in data.items():
                                cursor.execute("""
                                    INSERT OR REPLACE INTO agent_runs 
                                    (run_id, task, status, created_at, updated_at, steps_json, metadata_json)
                                    VALUES (?, ?, ?, ?, ?, ?, ?)
                                """, (
                                    run_id,
                                    run_info.get("task", "Unknown"),
                                    run_info.get("status", "completed"),
                                    time.time(),
                                    time.time(),
                                    json.dumps(run_info.get("steps", [])),
                                    json.dumps(run_info)
                                ))
                except Exception as e:
                    print(f"[Storage Migration Error] run_history.json: {e}")

            conn.commit()

    def save_run(self, run_id: str, task: str, status: str, steps: List[Dict[str, Any]], metadata: Optional[Dict[str, Any]] = None):
        now = time.time()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO agent_runs 
                (run_id, task, status, created_at, updated_at, steps_json, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                run_id,
                task,
                status,
                now,
                now,
                json.dumps(steps),
                json.dumps(metadata or {})
            ))
            conn.commit()

    def append_computer_history(self, run_id: str, step_idx: int, action_type: str, coords: Optional[List[int]], text_typed: Optional[str], explanation: str, screenshot_path: str):
        now = time.time()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO computer_history 
                (run_id, step_index, action_type, coords, text_typed, explanation, screenshot_path, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                run_id,
                step_idx,
                action_type,
                json.dumps(coords) if coords else None,
                text_typed,
                explanation,
                screenshot_path,
                now
            ))
            conn.commit()

    def get_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM agent_runs WHERE run_id = ?", (run_id,))
            row = cursor.fetchone()
            if row:
                return {
                    "run_id": row["run_id"],
                    "task": row["task"],
                    "status": row["status"],
                    "created_at": row["created_at"],
                    "steps": json.loads(row["steps_json"] or "[]"),
                    "metadata": json.loads(row["metadata_json"] or "{}")
                }
        return None

    def get_history(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM computer_history ORDER BY id DESC LIMIT ?", (limit,))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

# Default singleton instance
storage = AgentStorage()
