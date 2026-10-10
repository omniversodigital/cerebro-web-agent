import os
import argparse
import sys

# Ensure current dir and project dir are on path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.graph import build_agent_graph

def parse_args():
    parser = argparse.ArgumentParser(description="Run the Cerebro Autonomous Web Research Agent")
    parser.add_argument(
        "--query",
        type=str,
        required=True,
        help="Research topic or search query"
    )
    parser.add_argument(
        "--seed-url",
        type=str,
        default=None,
        help="Optional initial page URL to crawl first"
    )
    parser.add_argument(
        "--skip-n8n",
        action="store_true",
        default=False,
        help="Skip n8n webhook dispatch even if the agent decides to trigger it"
    )
    return parser.parse_args()

def main():
    args = parse_args()
    print(f"=== Initializing Research Agent ===")
    print(f"Query: {args.query}")
    if args.seed_url:
        print(f"Seed URL: {args.seed_url}")
    if args.skip_n8n:
        print("n8n webhook: DISABLED")
    print("===================================\n")
    
    # Initialize state
    initial_state = {
        "query": args.query,
        "urls_to_crawl": [args.seed_url] if args.seed_url else [],
        "crawled_pages": [],
        "attempted_urls": [],
        "extracted_facts": [],
        "actions_taken": [],
        "final_report": "",
        "webhook_status": "",
        "skip_n8n": args.skip_n8n,
        "next_node": "plan"
    }
    
    # Build graph
    app = build_agent_graph()
    
    print("[Agent] Initiating execution path...")
    try:
        final_state = app.invoke(initial_state)
        
        print("\n===================================")
        print("=== Execution Completed Successfully ===")
        print("===================================\n")
        
        print(f"Pages Scraped: {len(final_state.get('crawled_pages', []))}")
        print(f"Facts Extracted: {len(final_state.get('extracted_facts', []))}\n")
        
        print("--- Extracted Facts ---")
        for i, fact in enumerate(final_state.get('extracted_facts', [])):
            print(f"{i+1}. {fact}")
            
        print("\n--- Final Research Report ---")
        print(final_state.get('final_report', 'No report compiled.'))
        
        print("\n--- Webhook Dispatch Status ---")
        print(f"Status: {final_state.get('webhook_status', 'Not executed')}")
        print("===================================\n")
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
