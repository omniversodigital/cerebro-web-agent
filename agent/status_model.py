"""
Prints JSON: {"model": "<active model name>"}
Used by the Express status API endpoint.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv(dotenv_path=r"C:\Users\Admin\CEREBRO_UNIFIED\.env")

def is_valid(key):
    if not key:
        return False
    k = key.strip()
    if len(k) < 10:
        return False
    for bad in ("REVOKED", "ENTER_", "MOCK_", "VAULTED", "api03-R3mzsIunwpHeu"):
        if bad in k:
            return False
    return True

openrouter = os.getenv("OPENROUTER_API_KEY", "")
anthropic  = os.getenv("ANTHROPIC_API_KEY", "")
openai     = os.getenv("OPENAI_API_KEY", "")

if is_valid(openrouter):
    model = "claude-3-5-sonnet (OpenRouter)"
elif is_valid(anthropic):
    model = "claude-3-5-sonnet (Anthropic)"
elif is_valid(openai):
    model = "gpt-4o (OpenAI)"
else:
    # Try local Ollama
    try:
        import urllib.request
        data = json.loads(
            urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2).read()
        )
        models_list = data.get("models", [])
        model = models_list[0]["name"] if models_list else "ollama (no models)"
    except Exception:
        model = "ollama (offline)"

print(json.dumps({"model": model}))
