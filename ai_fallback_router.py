import os
import json
import requests
from typing import Dict, Any, Optional

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

FREE_MODELS = [
    "google/gemini-2.0-flash-exp:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "deepseek/deepseek-r1:free",
    "mistralai/mistral-7b-instruct:free"
]

class AIFallbackRouter:
    def __init__(self):
        self.openrouter_api_key = os.getenv("OPENROUTER_API_KEY", "")
        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "")

    def call_openrouter(self, prompt: str, system_instruction: str = "", model: str = FREE_MODELS[0]) -> Optional[str]:
        """Execute completion call against OpenRouter free tier API."""
        headers = {
            "Content-Type": "application/json",
            "HTTP-Referer": "https://omniverso.digital",
            "X-Title": "CEREBRO OMEGA Agent"
        }
        if self.openrouter_api_key:
            headers["Authorization"] = f"Bearer {self.openrouter_api_key}"

        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_instruction or "You are CEREBRO, a sovereign AI agent."},
                {"role": "user", "content": prompt}
            ],
            "max_tokens": 1000
        }

        try:
            resp = requests.post(OPENROUTER_URL, headers=headers, json=payload, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                choices = data.get("choices", [])
                if choices and len(choices) > 0:
                    return choices[0].get("message", {}).get("content", "")
            else:
                print(f"[OpenRouter Fallback Warning] Status {resp.status_code}: {resp.text[:200]}")
        except Exception as e:
            print(f"[OpenRouter Fallback Exception]: {e}")
        return None

    def call_with_fallback(self, primary_fn, prompt: str, system_instruction: str = "") -> str:
        """Attempt primary LLM invocation (e.g. Gemini/Vertex); fallback to OpenRouter or local mock if quota error occurs."""
        try:
            res = primary_fn()
            if res:
                return res
        except Exception as primary_err:
            err_str = str(primary_err)
            print(f"[AI Fallback Triggered] Primary model error: {err_str[:150]}")

            # Try OpenRouter Free Models
            for model_name in FREE_MODELS:
                print(f"[AI Fallback Router] Attempting fallback model: {model_name}")
                fallback_res = self.call_openrouter(prompt, system_instruction, model=model_name)
                if fallback_res:
                    return fallback_res

        # Final Local Graceful Fallback if all APIs fail
        return f"[Fallback Agent Engine]: Proceeding with default action for prompt: '{prompt[:50]}...'"

router = AIFallbackRouter()
