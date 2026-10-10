import sys
import os
import json

# Add project root to python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.tools import get_qdrant_client, config

def main():
    client = get_qdrant_client()
    col_name = config.get("qdrant_collection_name", "cerebro_research_facts")
    
    if not client.collection_exists(col_name):
        print(json.dumps([]))
        return
        
    try:
        # Scroll up to 100 points
        scroll_res = client.scroll(
            collection_name=col_name,
            limit=100,
            with_payload=True,
            with_vectors=False
        )
        points = scroll_res[0]
        facts_list = []
        for p in points:
            facts_list.append({
                "id": p.id,
                "document": p.payload.get("document", ""),
                "source": p.payload.get("source", "Unknown Source")
            })
        print(json.dumps(facts_list))
    except Exception as e:
        print(json.dumps([{"error": f"Failed to read facts: {str(e)}"}]))

if __name__ == "__main__":
    main()
