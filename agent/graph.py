import os
import json
from typing import TypedDict, List, Dict, Any, Optional
from dotenv import load_dotenv

from langchain_core.messages import SystemMessage, HumanMessage
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END

import re
from agent.tools import scrape_url, store_facts, trigger_n8n_webhook

# Load env variables
env_path = "C:\\Users\\Admin\\CEREBRO_UNIFIED\\.env"

def parse_lenient_json(content: str) -> dict:
    """
    Parses JSON content robustly. If standard json.loads fails due to control characters 
    or unescaped quotes, attempts regex-based key extraction.
    """
    try:
        return json.loads(content, strict=False)
    except Exception as parse_err:
        print(f"[JSON Parser] Lenient parsing failed: {parse_err}. Attempting regex-based extraction.")
        
        # 1. Check for 'facts' extraction format
        if '"facts"' in content:
            facts_match = re.search(r'"facts"\s*:\s*\[(.*?)\]', content, re.DOTALL)
            if facts_match:
                facts_str = facts_match.group(1)
                facts = re.findall(r'"(.*?)"', facts_str)
                return {"facts": [f.replace('\\"', '"') for f in facts]}
                
        # 2. Check for 'decision' and 'urls' planning format
        if '"decision"' in content:
            decision_match = re.search(r'"decision"\s*:\s*"(.*?)"', content)
            urls_match = re.search(r'"urls"\s*:\s*\[(.*?)\]', content, re.DOTALL)
            decision = decision_match.group(1) if decision_match else "analyze"
            urls = []
            if urls_match:
                urls = re.findall(r'"(.*?)"', urls_match.group(1))
            return {
                "decision": decision,
                "urls": [u.replace('\\"', '"') for u in urls]
            }
            
        # 3. Check for 'report' and action execution format
        if '"report"' in content:
            # Match non-greedily from '"report": "' to the end or to the next key
            report_match = re.search(r'"report"\s*:\s*"(.*?)"\s*,\s*"trigger_n8n"', content, re.DOTALL)
            if not report_match:
                report_match = re.search(r'"report"\s*:\s*"(.*?)"\s*,\s*"webhook_payload"', content, re.DOTALL)
            if not report_match:
                # Fallback matching from report to ending quotes
                report_match = re.search(r'"report"\s*:\s*"(.*)"', content, re.DOTALL)
                
            report = ""
            if report_match:
                report = report_match.group(1)
                # Clean up escapes
                report = report.replace("\\n", "\n").replace('\\"', '"')
                
            trigger = False
            trigger_match = re.search(r'"trigger_n8n"\s*:\s*(true|false)', content, re.IGNORECASE)
            if trigger_match:
                trigger = trigger_match.group(1).lower() == "true"
                
            payload = {}
            title_match = re.search(r'"title"\s*:\s*"(.*?)"', content)
            if title_match:
                payload["title"] = title_match.group(1)
            summary_match = re.search(r'"summary"\s*:\s*"(.*?)"', content)
            if summary_match:
                payload["summary"] = summary_match.group(1)
            severity_match = re.search(r'"severity"\s*:\s*"(.*?)"', content)
            if severity_match:
                payload["severity"] = severity_match.group(1)
                
            if report:
                return {
                    "report": report,
                    "trigger_n8n": trigger,
                    "webhook_payload": payload
                }
                
        # Raise the original parsing error if no patterns could be extracted
        raise parse_err
load_dotenv(dotenv_path=env_path)

# Initialize LLM helper
def get_llm():
    openrouter_key = os.getenv("OPENROUTER_API_KEY")
    openai_key = os.getenv("OPENAI_API_KEY")
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    
    def is_valid(key):
        if not key:
            return False
        k = key.strip()
        if not k or len(k) < 10:
            return False
        # Ignore comments, placeholders, and the known expired/revoked key
        if any(x in k for x in ["REVOKED", "ENTER_", "MOCK_", "VAULTED", "api03-R3mzsIunwpHeu"]):
            return False
        return True

    if is_valid(openrouter_key):
        return ChatOpenAI(
            model="anthropic/claude-3-5-sonnet",
            openai_api_key=openrouter_key,
            openai_api_base="https://openrouter.ai/api/v1"
        )
    elif is_valid(anthropic_key):
        return ChatAnthropic(
            model="claude-3-5-sonnet-20241022",
            anthropic_api_key=anthropic_key
        )
    elif is_valid(openai_key):
        return ChatOpenAI(
            model="gpt-4o",
            openai_api_key=openai_key
        )
    else:
        # Fallback to local Ollama. Check available models to choose a resource-efficient one.
        import requests
        model_name = "llama3.2:latest"
        try:
            r = requests.get("http://localhost:11434/api/tags", timeout=3)
            if r.status_code == 200:
                models_info = r.json().get("models", [])
                names = [m["name"] for m in models_info]
                if "llama3.2:latest" in names:
                    model_name = "llama3.2:latest"
                elif "llama3.2:3b" in names:
                    model_name = "llama3.2:3b"
                elif "hermes3:latest" in names:
                    model_name = "hermes3:latest"
                elif names:
                    model_name = names[0]
        except Exception:
            pass

        print(f"[LLM Router] No valid Cloud API key found. Falling back to local Ollama (model: {model_name}).")
        return ChatOpenAI(
            model=model_name,
            openai_api_key="ollama",
            openai_api_base="http://localhost:11434/v1"
        )



# Define Agent State
class AgentState(TypedDict):
    query: str
    urls_to_crawl: List[str]
    crawled_pages: List[Dict[str, Any]]
    attempted_urls: List[str]
    extracted_facts: List[str]
    actions_taken: List[Dict[str, Any]]
    final_report: str
    webhook_status: str
    skip_n8n: bool
    next_node: str

# 1. Planner Node
def plan_node(state: AgentState) -> Dict[str, Any]:
    import time
    t0 = time.time()
    query = state["query"]
    crawled = state.get("crawled_pages", [])
    attempted = state.get("attempted_urls", [])

    iteration = len(attempted)  # rough cycle count
    print(f"\n{'-'*52}")
    print(f"[PLAN  #{iteration + 1}] Query: {query[:80]}")
    print(f"  Pages crawled: {len(crawled)}  |  URLs attempted: {len(attempted)}")
    print(f"{'-'*52}")

    # If we have pending URLs to crawl (like the seed URL) and haven't crawled anything yet, crawl them first!
    pending_urls = state.get("urls_to_crawl", [])
    pending_urls = [u for u in pending_urls if u not in attempted]
    if pending_urls and not crawled:
        print(f"[PLAN] Seed URLs detected - routing to Crawler: {pending_urls}")
        return {
            "urls_to_crawl": pending_urls,
            "next_node": "crawl"
        }
        
    llm = get_llm()
    
    prompt = f"""You are the Planning Node of the Autonomous Web Research Agent.
Your task is to decide the next action to satisfy the user query: "{query}".

Already crawled pages:
{json.dumps([{'url': p['url'], 'title': p['title']} for p in crawled], indent=2)}


Decide if we need to crawl more URLs to collect relevant information, or if we have enough information to analyze and compile the final report.

Respond ONLY with a JSON object in this format:
{{
  "decision": "crawl" or "analyze",
  "urls": ["https://example.com/url-to-crawl-1"],
  "reason": "Short reason for decision"
}}
"""
    try:
        response = llm.invoke([
            SystemMessage(content="You must respond with valid JSON only. Do not wrap code in markdown formatting or add explanatory text."),
            HumanMessage(content=prompt)
        ])
        
        # Clean response content (sometimes LLMs wrap JSON in markdown block)
        clean_content = response.content.strip()
        if clean_content.startswith("```json"):
            clean_content = clean_content.split("```json")[1].split("```")[0].strip()
        elif clean_content.startswith("```"):
            clean_content = clean_content.split("```")[1].split("```")[0].strip()
            
        data = parse_lenient_json(clean_content)
        
        urls = data.get("urls", [])
        clean_urls = []
        for u in urls:
            clean_u = u.replace('\\/', '/').replace('\\.', '.').replace('\\', '')
            if clean_u not in attempted:
                clean_urls.append(clean_u)
            
        decision = data.get("decision")
        if decision == "crawl" and not clean_urls:
            print("[PLAN] All recommended URLs already attempted - forcing extract stage.")
            decision = "analyze"
            
        elapsed = round(time.time() - t0, 1)
        print(f"[PLAN  [OK]] Decision: {decision.upper()}  |  New URLs: {len(clean_urls)}  ({elapsed}s)")
        return {
            "urls_to_crawl": clean_urls if decision == "crawl" else [],
            "next_node": "crawl" if decision == "crawl" else "extract"
        }
    except Exception as e:
        print(f"[PLAN  [ERR]] Error: {e} - defaulting to extract.")
        return {
            "urls_to_crawl": [],
            "next_node": "extract"
        }

# 2. Crawler Node
def crawl_node(state: AgentState) -> Dict[str, Any]:
    import time
    t0 = time.time()
    urls = state.get("urls_to_crawl", [])
    crawled = state.get("crawled_pages", [])
    attempted = state.get("attempted_urls", [])

    print(f"\n{'-'*52}")
    print(f"[CRAWL] Targets: {len(urls)} URL(s)")
    print(f"{'-'*52}")

    if not urls:
        print("[CRAWL] No URLs queued - returning to Planner.")
        return {"crawled_pages": crawled, "next_node": "plan"}

    new_crawled  = list(crawled)
    new_attempted = list(attempted)
    for url in urls:
        print(f"[CRAWL] -> {url}")
        res = scrape_url(url, max_pages=1)
        new_attempted.append(url)
        if res.get("success") and res.get("pages"):
            pages = res["pages"]
            new_crawled.extend(pages)
            for p in pages:
                print(f"[CRAWL] [OK] \"{p.get('title', '?')}\" ({len(p.get('content',''))} chars)")
        else:
            print(f"[CRAWL] [ERR] Failed scraping {url}: {res.get('error')}")

    elapsed = round(time.time() - t0, 1)
    print(f"[CRAWL [OK]] Total pages now: {len(new_crawled)}  ({elapsed}s)")
    return {
        "crawled_pages": new_crawled,
        "urls_to_crawl": [],
        "attempted_urls": new_attempted,
        "next_node": "plan"
    }

# 3. Extractor Node
def extract_node(state: AgentState) -> Dict[str, Any]:
    import time
    t0 = time.time()
    llm = get_llm()
    crawled = state.get("crawled_pages", [])
    query = state["query"]

    print(f"\n{'-'*52}")
    print(f"[EXTRACT] Analysing {len(crawled)} page(s) with LLM")
    print(f"{'-'*52}")

    if not crawled:
        print("[EXTRACT] No pages available - skipping to vector ingest.")
        return {
            "extracted_facts": ["No pages were successfully crawled to extract information."],
            "next_node": "vector_ingest"
        }

    all_facts = []
    for page in crawled:
        url = page["url"]
        content = page["content"][:8000]
        print(f"[EXTRACT] Processing: {url[:70]}")

        prompt = f"""Analyze the following crawled web content from {url} and extract all key facts, statistics, news updates, or relevant claims that help answer this query: "{query}".

Web Content:
---
{content}
---

Respond ONLY with a JSON object containing a list of strings:
{{
  "facts": [
    "Fact 1...",
    "Fact 2..."
  ]
}}
"""
        try:
            response = llm.invoke([
                SystemMessage(content="Respond strictly with JSON. Do not write markdown tags or extra talk."),
                HumanMessage(content=prompt)
            ])

            clean_content = response.content.strip()
            if clean_content.startswith("```json"):
                clean_content = clean_content.split("```json")[1].split("```")[0].strip()
            elif clean_content.startswith("```"):
                clean_content = clean_content.split("```")[1].split("```")[0].strip()

            data = parse_lenient_json(clean_content)
            facts = data.get("facts", [])
            all_facts.extend(facts)
            print(f"[EXTRACT] [OK] {len(facts)} facts extracted from {url[:50]}")
        except Exception as e:
            print(f"[EXTRACT] [ERR] Failed parsing {url}: {e}")

    elapsed = round(time.time() - t0, 1)
    print(f"[EXTRACT [OK]] Total facts: {len(all_facts)}  ({elapsed}s)")
    return {
        "extracted_facts": all_facts,
        "next_node": "vector_ingest"
    }

# 4. Vector Ingestion Node
def vector_ingest_node(state: AgentState) -> Dict[str, Any]:
    import time
    t0 = time.time()
    facts = state.get("extracted_facts", [])
    crawled = state.get("crawled_pages", [])
    source = crawled[0]["url"] if crawled else "Unknown Web Source"

    print(f"\n{'-'*52}")
    print(f"[VECTOR] Storing {len(facts)} facts -> Qdrant")
    print(f"{'-'*52}")
    res = store_facts(facts, source)

    elapsed = round(time.time() - t0, 1)
    if res.get("success"):
        method = res.get('method', 'unknown')
        print(f"[VECTOR [OK]] Stored {res.get('count', 0)} facts via {method}  ({elapsed}s)")
    else:
        print(f"[VECTOR [ERR]] Storage warning: {res.get('error')}")

    return {
        "next_node": "decide_action"
    }

# 5. Decide & Act Node
def decide_action_node(state: AgentState) -> Dict[str, Any]:
    import time
    t0 = time.time()
    llm = get_llm()
    query = state["query"]
    facts = state.get("extracted_facts", [])
    
    facts_str = "\n".join([f"- {f}" for f in facts])
    
    print(f"\n{'-'*52}")
    print(f"[DECIDE] Compiling report from {len(facts)} facts")
    print(f"{'-'*52}")

    prompt = f"""You are the Action Decision Node of the Autonomous Web Research Agent.
You have gathered the following research facts to answer the user query: "{query}".

Research Facts:
{facts_str}

Please build a premium, highly detailed research report in Markdown.
Then, decide if we need to dispatch an automated notification/action to n8n (e.g. if the findings contain critical alerts, high-value updates, or actionable items).

Respond ONLY with a JSON object in this format:
{{
  "report": "# Premium Research Report\\n\\n...",
  "trigger_n8n": true or false,
  "webhook_payload": {{
     "title": "Alert title",
     "summary": "Short execution summary for Slack/Email",
     "severity": "info" or "warning" or "critical"
  }}
}}
"""
    try:
        response = llm.invoke([
            SystemMessage(content="Respond strictly with valid JSON. Do not include formatting marks around the JSON block."),
            HumanMessage(content=prompt)
        ])
        
        clean_content = response.content.strip()
        if clean_content.startswith("```json"):
            clean_content = clean_content.split("```json")[1].split("```")[0].strip()
        elif clean_content.startswith("```"):
            clean_content = clean_content.split("```")[1].split("```")[0].strip()
            
        data = parse_lenient_json(clean_content)

        report = data.get("report", "Failed to compile report.")
        trigger = data.get("trigger_n8n", False)
        payload = data.get("webhook_payload", {})

        status = "Skipped"
        # Respect the skip_n8n flag from the UI toggle
        if trigger and not state.get("skip_n8n", False):
            print("[DECIDE] Dispatching research alert to n8n webhookâ€¦")
            payload["report"] = report
            payload["query"] = query
            res = trigger_n8n_webhook(payload)
            if res.get("success"):
                status = "Dispatched Successfully"
                print("[DECIDE] [OK] n8n webhook dispatched.")
            else:
                status = f"Dispatch Failed: {res.get('error')}"
                print(f"[DECIDE] [ERR] n8n dispatch failed: {res.get('error')}")
        elif trigger and state.get("skip_n8n", False):
            status = "Skipped (toggle disabled)"
            print("[DECIDE] n8n trigger suppressed by UI toggle.")

        elapsed = round(time.time() - t0, 1)
        report_lines = len(report.splitlines())
        print(f"[DECIDE [OK]] Report: {report_lines} lines  |  n8n: {status}  ({elapsed}s)")
        return {
            "final_report": report,
            "webhook_status": status,
            "next_node": "end"
        }
    except Exception as e:
        print(f"[DECIDE [ERR]] Error: {e}")
        return {
            "final_report": "Error compiling report.",
            "webhook_status": f"Failed: {str(e)}",
            "next_node": "end"
        }

# Define conditional routing helper
def route_next(state: AgentState) -> str:
    return state["next_node"]

# Build & compile the graph
def build_agent_graph():
    workflow = StateGraph(AgentState)
    
    # Register Nodes
    workflow.add_node("plan", plan_node)
    workflow.add_node("crawl", crawl_node)
    workflow.add_node("extract", extract_node)
    workflow.add_node("vector_ingest", vector_ingest_node)
    workflow.add_node("decide_action", decide_action_node)
    
    # Establish Entrypoint
    workflow.set_entry_point("plan")
    
    # Define conditional edges from plan node
    workflow.add_conditional_edges(
        "plan",
        route_next,
        {
            "crawl": "crawl",
            "extract": "extract"
        }
    )
    
    # Define static transitions
    workflow.add_edge("crawl", "plan")
    workflow.add_edge("extract", "vector_ingest")
    workflow.add_edge("vector_ingest", "decide_action")
    workflow.add_edge("decide_action", END)
    
    return workflow.compile()

