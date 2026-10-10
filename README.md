# 🌐 Cerebro Autonomous Web Agent
### Multi-Modal Browser Operator, Vector Memory & Distributed Automation Mesh

[![Playwright](https://img.shields.io/badge/Playwright-Automated_Browser-45ba4b?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Qdrant](https://img.shields.io/badge/Qdrant-Vector_Database-dc2626?logo=qdrant&logoColor=white)](https://qdrant.tech/)
[![Python](https://img.shields.io/badge/Python-3.12-blue?logo=python&logoColor=white)](https://www.python.org/)
[![Docker](https://img.shields.io/badge/Docker-Containerized-2496ed?logo=docker&logoColor=white)](https://docker.com)
[![n8n](https://img.shields.io/badge/n8n-Workflow_Mesh-ea580c?logo=n8n&logoColor=white)](https://n8n.io)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Cerebro Autonomous Web Agent** is an enterprise-grade autonomous browser automation engine that executes complex multi-step web workflows, inspects dynamic DOM structures, and indexes real-time online intelligence into persistent vector storage.

---

## 🏛️ System Architecture

```mermaid
flowchart LR
    classDef agent fill:#1a237e,stroke:#3949ab,stroke-width:2px,color:#fff
    classDef browser fill:#004d40,stroke:#00897b,stroke-width:2px,color:#fff
    classDef memory fill:#bf360c,stroke:#ff7043,stroke-width:2px,color:#fff
    classDef orch fill:#263238,stroke:#546e7a,stroke-width:2px,color:#fff

    User["Task Instruction / Webhook Trigger"]:::orch --> Orchestrator["Cerebro Agent Core"]:::agent
    
    subgraph Execution ["Execution Engine"]
        Orchestrator --> Playwright["Playwright Chromium Engine"]:::browser
        Playwright --> DOM["Dynamic DOM Parser & Screenshot Analyzer"]:::browser
        DOM --> ActionLoop["Autonomous Action Loop (Click / Fill / Navigate)"]:::browser
    end

    subgraph Memory ["Cognitive Memory Layer"]
        ActionLoop --> Chunking["Semantic Text Chunking"]:::memory
        Chunking --> Qdrant["Qdrant Vector Database (Cosine Distance)"]:::memory
        Qdrant --> Retrieval["RAG Historical Context Retrieval"]:::memory
    end

    Retrieval --> Orchestrator
    ActionLoop --> n8n["n8n Webhook Notification Dispatcher"]:::orch
```

---

## ⚡ Core Features

- **Multi-Step Goal Execution**: Interprets natural language instructions into concrete browser interaction chains (form filling, navigation, CAPTCHA bypass heuristics, dynamic pagination).
- **Persistent Qdrant Memory**: Automatically vectors extracted page content, ensuring the agent remembers past sessions, credentials, and scraped datasets.
- **Stealth & Anti-Fingerprinting**: Emulates human viewport behavior, random delays, and custom User-Agent headers to avoid bot detection traps.
- **Multi-Model LLM Routing**: Intelligently switches between local models (Ollama/LiteRT) and cloud backends (Claude 3.5 Sonnet / Gemini 2.5 Pro) based on context complexity.
- **Workflow Interoperability**: Seamless bi-directional webhooks with n8n and Zapier for event-driven automation.

---

## 🛠️ Quickstart

### 1. Prerequisites
```bash
# Clone the repository
git clone https://github.com/omniversodigital/cerebro-web-agent.git
cd cerebro-web-agent

# Install dependencies and Playwright browsers
pip install -r requirements.txt || uv pip install -r requirements.txt
playwright install chromium
```

### 2. Launch Qdrant Vector Engine
```bash
docker run -d -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant
```

### 3. Run the Agent
```bash
# Execute autonomous navigation task
python agent.py --goal "Extract competitive pricing intelligence from target marketplace" --save-vector
```

---

## 🔒 Security & Privacy
- Sensitive cookies and authentication states are encrypted at rest using AES-GCM.
- In-memory credential scrubbing ensures API keys and login tokens are never logged or exported in telemetry traces.

---

## 📄 License
MIT License © Omniverso Digital. All rights reserved.
