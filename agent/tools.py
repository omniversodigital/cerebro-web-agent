import os
import json
import random
import requests
from dotenv import load_dotenv
from qdrant_client import QdrantClient
from qdrant_client.http import models
from apify_client import ApifyClient

# Resolve config path
current_dir = os.path.dirname(os.path.abspath(__file__))
project_dir = os.path.dirname(current_dir)
config_path = os.path.join(project_dir, "config.json")

with open(config_path, "r") as f:
    config = json.load(f)

# Load env variables from the main cerebro unified path
env_path = "C:\\Users\\Admin\\CEREBRO_UNIFIED\\.env"
load_dotenv(dotenv_path=env_path)

# Initialize Apify client
apify_token = os.getenv("APIFY_TOKEN")
apify_client = ApifyClient(apify_token) if apify_token else None

SCRAPER_URL = f"http://localhost:{config.get('scraper_port', 3000)}"

def scrape_url(url: str, max_pages: int = 1) -> dict:
    """
    Triggers the local Express Crawlee crawler service to scrape a webpage.
    """
    try:
        payload = {"url": url, "maxPages": max_pages}
        response = requests.post(f"{SCRAPER_URL}/crawl", json=payload, timeout=180)
        if response.status_code == 200:
            return response.json()
        return {"success": False, "error": f"HTTP {response.status_code}: {response.text}"}
    except Exception as e:
        return {"success": False, "error": f"Failed to reach scraping service: {str(e)}"}

def call_apify_actor(actor_id: str, run_input: dict) -> dict:
    """
    Calls a pre-configured Apify actor using the APIFY_TOKEN.
    """
    if not apify_client:
        return {"success": False, "error": "APIFY_TOKEN is missing from env"}
    try:
        run = apify_client.actor(actor_id).call(run_input=run_input)
        dataset_items = apify_client.dataset(run["defaultDatasetId"]).list_items().items
        return {"success": True, "items": dataset_items}
    except Exception as e:
        return {"success": False, "error": f"Apify Actor execution failed: {str(e)}"}

def get_qdrant_client() -> QdrantClient:
    """
    Initializes and returns a Qdrant client based on config path.
    """
    db_path = config.get("qdrant_db_path", "./qdrant_db")
    # Handle making directory if needed
    os.makedirs(db_path, exist_ok=True)
    return QdrantClient(path=db_path)

def store_facts(facts: list[str], source_url: str) -> dict:
    """
    Saves extracted research facts into Qdrant vector database.
    Integrates a dynamic fallback vectorizer to operate keyless and compilation-free.
    """
    if not facts:
        return {"success": True, "count": 0}
        
    client = get_qdrant_client()
    col_name = config.get("qdrant_collection_name", "cerebro_research_facts")
    
    # Try using qdrant-client's built-in fastembed support
    try:
        client.add(
            collection_name=col_name,
            documents=facts,
            metadata=[{"source": source_url} for _ in facts]
        )
        return {"success": True, "count": len(facts), "method": "fastembed"}
    except Exception as fastembed_err:
        # Fallback to custom vector scoring if fastembed fails or is not installed
        try:
            # Check collection existence
            if not client.collection_exists(col_name):
                client.create_collection(
                    collection_name=col_name,
                    vectors_config=models.VectorParams(size=384, distance=models.Distance.COSINE)
                )
            
            points = []
            for fact in facts:
                # Custom character frequency vector mapping (384 dimensions)
                vector = [0.0] * 384
                for char in fact:
                    vector[ord(char) % 384] += 1.0
                
                # Normalize vector to unit length
                magnitude = sum(v * v for v in vector) ** 0.5
                if magnitude > 0:
                    vector = [v / magnitude for v in vector]
                
                points.append(
                    models.PointStruct(
                        id=random.randint(1, 100000000),
                        vector=vector,
                        payload={"document": fact, "source": source_url}
                    )
                )
            
            client.upsert(collection_name=col_name, points=points)
            return {"success": True, "count": len(facts), "method": "fallback_vectorizer", "warning": str(fastembed_err)}
        except Exception as fallback_err:
            return {"success": False, "error": f"Qdrant storage failed: {str(fastembed_err)} | Fallback: {str(fallback_err)}"}

def query_facts(query_text: str, limit: int = 5) -> list[dict]:
    """
    Queries Qdrant for facts related to query_text.
    """
    client = get_qdrant_client()
    col_name = config.get("qdrant_collection_name", "cerebro_research_facts")
    
    if not client.collection_exists(col_name):
        return []
        
    try:
        results = client.query(
            collection_name=col_name,
            query_text=query_text,
            limit=limit
        )
        return [{"text": r.document, "source": r.payload.get("source"), "score": r.score} for r in results]
    except Exception:
        # Fallback keyword overlap scoring
        try:
            scroll_res = client.scroll(collection_name=col_name, limit=100)
            points = scroll_res[0]
            matched = []
            query_tokens = set(query_text.lower().split())
            
            for p in points:
                doc = p.payload.get("document", "")
                source = p.payload.get("source", "")
                overlap = len(set(doc.lower().split()) & query_tokens)
                if overlap > 0:
                    matched.append((overlap, doc, source))
            
            # Sort descending by overlap count
            matched.sort(key=lambda x: x[0], reverse=True)
            return [{"text": doc, "source": src, "score": float(overlap)} for overlap, doc, src in matched[:limit]]
        except Exception:
            return []

def trigger_n8n_webhook(payload: dict) -> dict:
    """
    Fires n8n execution trigger webhook.
    """
    n8n_url = config.get("n8n_webhook_url")
    try:
        response = requests.post(n8n_url, json=payload, timeout=15)
        if response.status_code in [200, 201]:
            return {"success": True, "response": response.text}
        return {"success": False, "error": f"HTTP {response.status_code}: {response.text}"}
    except Exception as e:
        return {"success": False, "error": f"Failed to send webhook to n8n: {str(e)}"}
