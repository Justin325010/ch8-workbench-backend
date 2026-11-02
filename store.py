"""SQLite-backed industrial project store.

Keeps project configuration, data quality reports, trained adapter metadata,
MPC runs, and audit events. Model weights that are not JSON-serialisable stay
in process memory via the service layer; only reproducible metadata is stored.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
RUNTIME = BASE / "runtime"
RUNTIME.mkdir(parents=True, exist_ok=True)
DB_PATH = RUNTIME / "industrial_platform.db"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self):
        with self._lock, self._conn:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS datasets (
                    project_id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    columns_json TEXT NOT NULL,
                    row_count INTEGER NOT NULL,
                    report_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS adapters (
                    project_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    metrics_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mpc_runs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL,
                    event TEXT NOT NULL,
                    level TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )

    def create_project(self, data: dict) -> dict:
        project_id = uuid.uuid4().hex[:12]
        now = utc_now()
        project = {
            "id": project_id,
            "name": data.get("name") or "未命名现场项目",
            "config": data,
            "created_at": now,
            "updated_at": now,
        }
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO projects(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)",
                (project_id, project["name"], json.dumps(project["config"], ensure_ascii=False), now, now),
            )
        self.add_audit(project_id, f"创建现场项目：{project['name']}", "info")
        return project

    def get_project(self, project_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "config": json.loads(row["config_json"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list_projects(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT id,name,created_at FROM projects ORDER BY created_at DESC").fetchall()
        return [dict(row) for row in rows]

    def save_dataset(self, project_id: str, filename: str, columns: list[str], row_count: int, report: dict) -> None:
        now = utc_now()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO datasets(project_id,filename,columns_json,row_count,report_json,created_at) "
                "VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(project_id) DO UPDATE SET filename=excluded.filename, columns_json=excluded.columns_json, "
                "row_count=excluded.row_count, report_json=excluded.report_json, created_at=excluded.created_at",
                (project_id, filename, json.dumps(columns, ensure_ascii=False), row_count, json.dumps(report, ensure_ascii=False), now),
            )
        self.add_audit(project_id, f"接入数据 {filename}，共 {row_count} 行", "info")

    def get_dataset(self, project_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM datasets WHERE project_id=?", (project_id,)).fetchone()
        if not row:
            return None
        return {
            "filename": row["filename"],
            "columns": json.loads(row["columns_json"]),
            "row_count": row["row_count"],
            "report": json.loads(row["report_json"]),
            "created_at": row["created_at"],
        }

    def save_adapter(self, project_id: str, name: str, metrics: dict) -> None:
        now = utc_now()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO adapters(project_id,name,metrics_json,created_at) VALUES(?,?,?,?) "
                "ON CONFLICT(project_id) DO UPDATE SET name=excluded.name, metrics_json=excluded.metrics_json, created_at=excluded.created_at",
                (project_id, name, json.dumps(metrics, ensure_ascii=False), now),
            )
        self.add_audit(project_id, f"训练并注册小模型 {name}", "info")

    def get_adapter(self, project_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM adapters WHERE project_id=?", (project_id,)).fetchone()
        if not row:
            return None
        return {
            "name": row["name"],
            "metrics": json.loads(row["metrics_json"]),
            "created_at": row["created_at"],
        }

    def save_mpc_run(self, project_id: str, config: dict, result: dict) -> str:
        run_id = uuid.uuid4().hex[:12]
        now = utc_now()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO mpc_runs(id,project_id,config_json,result_json,created_at) VALUES(?,?,?,?,?)",
                (run_id, project_id, json.dumps(config, ensure_ascii=False), json.dumps(result, ensure_ascii=False), now),
            )
        self.add_audit(project_id, f"执行 MPC，模式={config.get('mode')}，安全校验通过", "warning")
        return run_id

    def get_mpc_runs(self, project_id: str, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM mpc_runs WHERE project_id=? ORDER BY created_at DESC LIMIT ?", (project_id, limit)
            ).fetchall()
        return [
            {"id": row["id"], "config": json.loads(row["config_json"]), "result": json.loads(row["result_json"]), "created_at": row["created_at"]}
            for row in rows
        ]

    def add_audit(self, project_id: str, event: str, level: str = "info") -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO audit_log(project_id,event,level,created_at) VALUES(?,?,?,?)",
                (project_id, event, level, utc_now()),
            )

    def get_audit(self, project_id: str, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT event,level,created_at FROM audit_log WHERE project_id=? ORDER BY id DESC LIMIT ?",
                (project_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]


_STORE: Store | None = None


def get_store() -> Store:
    global _STORE
    if _STORE is None:
        _STORE = Store()
    return _STORE
