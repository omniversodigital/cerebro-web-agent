"""
Prints JSON: {"ok": true, "collections": N, "facts": M}
Used by the Express /api/status/qdrant endpoint.
Uses file-based QdrantClient matching the project config (no port 6333 needed).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load config
config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")
with open(config_path) as f:
    config = json.load(f)

db_path    = config.get("qdrant_db_path", "./qdrant_db")
col_name   = config.get("qdrant_collection_name", "cerebro_research_facts")

# Resolve relative path relative to project root
project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isabs(db_path):
    db_path = os.path.join(project_dir, db_path.lstrip("./"))

try:
    from qdrant_client import QdrantClient
    client = QdrantClient(path=db_path)
    cols = client.get_collections().collections
    fact_count = 0
    for c in cols:
        if c.name == col_name:
            info = client.get_collection(col_name)
            fact_count = info.points_count or 0
    print(json.dumps({"ok": True, "collections": len(cols), "facts": fact_count}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e), "collections": 0, "facts": 0}))
