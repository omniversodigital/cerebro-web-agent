document.addEventListener('DOMContentLoaded', () => {

  // ── Element refs ────────────────────────────────────────────────────────────
  const navButtons        = document.querySelectorAll('.nav-btn');
  const tabPanels         = document.querySelectorAll('.tab-panel');

  const runForm           = document.getElementById('run-agent-form');
  const submitBtn         = document.getElementById('submit-btn');
  const loaderSpinner     = submitBtn.querySelector('.loader-spinner');
  const terminalFeed      = document.getElementById('terminal-feed');
  const agentStatusLabel  = document.getElementById('agent-status-label');
  const abortBtn          = document.getElementById('abort-btn');
  const autoscrollToggle  = document.getElementById('autoscroll-toggle');
  const factsCountBadge   = document.getElementById('facts-count-badge');

  const reportContainer   = document.getElementById('report-container');
  const reportContentBody = document.getElementById('report-content-body');
  const copyReportBtn     = document.getElementById('copy-report-btn');
  const exportReportBtn   = document.getElementById('export-report-btn');

  const crawlTestForm     = document.getElementById('crawl-test-form');
  const crawlTestResult   = document.getElementById('crawl-test-result');

  const refreshFactsBtn   = document.getElementById('refresh-facts-btn');
  const factsSearchInput  = document.getElementById('facts-search-input');
  const factsGridBody     = document.getElementById('facts-grid-body');

  const historyListBody   = document.getElementById('history-list-body');
  const clearHistoryBtn   = document.getElementById('clear-history-btn');

  const statusScraper     = document.getElementById('status-scraper');
  const statusModel       = document.getElementById('status-model');
  const statusQdrant      = document.getElementById('status-qdrant');

  let currentReportMarkdown = '';
  let allFacts   = [];
  let activeSSE  = null;

  // Phase banner colours (matches [PLAN] [CRAWL] etc from graph.py)
  const PHASE_COLORS = {
    PLAN:    '#a78bfa',
    CRAWL:   '#38bdf8',
    EXTRACT: '#fbbf24',
    VECTOR:  '#34d399',
    DECIDE:  '#f472b6',
  };

  // ── Utility ─────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function nowHHMMSS() {
    return new Date().toTimeString().slice(0, 8);
  }

  // ── Status badges ────────────────────────────────────────────────────────────
  async function checkSystemStatus() {
    // Scraper
    try {
      const r = await fetch('/health', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      statusScraper.textContent = d.status === 'OK' ? 'Scraper: Online' : 'Scraper: Error';
      statusScraper.classList.toggle('status-active', d.status === 'OK');
    } catch {
      statusScraper.textContent = 'Scraper: Offline';
      statusScraper.classList.remove('status-active');
    }

    // LLM model
    try {
      const r = await fetch('/api/status/model', { signal: AbortSignal.timeout(6000) });
      const d = await r.json();
      statusModel.textContent = `LLM: ${d.model || 'Unknown'}`;
      statusModel.classList.add('status-active');
    } catch {
      statusModel.textContent = 'LLM: Offline';
      statusModel.classList.remove('status-active');
    }

    // Qdrant
    try {
      const r = await fetch('/api/status/qdrant', { signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      if (d.ok) {
        statusQdrant.textContent = `Qdrant: ${d.facts ?? 0} facts`;
        statusQdrant.classList.add('status-active');
      } else {
        statusQdrant.textContent = 'Qdrant: No DB';
        statusQdrant.classList.remove('status-active');
      }
    } catch {
      statusQdrant.textContent = 'Qdrant: Offline';
      statusQdrant.classList.remove('status-active');
    }
  }
  checkSystemStatus();
  setInterval(checkSystemStatus, 20000);

  // ── Tab navigation ───────────────────────────────────────────────────────────
  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.getAttribute('data-tab');
      navButtons.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${t}`).classList.add('active');
      if (t === 'memory')  fetchFacts();
      if (t === 'history') fetchHistory();
    });
  });

  // ── Terminal helpers ─────────────────────────────────────────────────────────
  function termLog(msg, isErr = false) {
    if (!msg.trim()) return;
    const line   = document.createElement('span');
    const ts     = document.createElement('span');
    ts.className = 'term-ts';
    ts.textContent = nowHHMMSS() + ' ';

    // Color-code phase banners
    const phaseMatch = msg.match(/\[(PLAN|CRAWL|EXTRACT|VECTOR|DECIDE)/);
    if (phaseMatch) {
      line.style.color = PHASE_COLORS[phaseMatch[1]] || '';
    } else if (isErr) {
      line.className = 'term-err';
    }

    line.prepend(ts);
    line.append(document.createTextNode(msg + '\n'));
    terminalFeed.appendChild(line);

    if (!autoscrollToggle || autoscrollToggle.checked) {
      terminalFeed.parentElement.scrollTop = terminalFeed.parentElement.scrollHeight;
    }
  }

  function termClear() { terminalFeed.innerHTML = ''; }

  function setRunning(running) {
    submitBtn.disabled = running;
    loaderSpinner.classList.toggle('hidden', !running);
    agentStatusLabel.textContent = running ? 'Running…' : 'Idle';
    agentStatusLabel.style.color  = running ? 'var(--accent-green)' : '';
    agentStatusLabel.classList.toggle('running', running);
    if (abortBtn) abortBtn.classList.toggle('hidden', !running);
  }

  // ── Abort button ─────────────────────────────────────────────────────────────
  if (abortBtn) {
    abortBtn.addEventListener('click', () => {
      if (activeSSE) { activeSSE.close(); activeSSE = null; }
      setRunning(false);
      agentStatusLabel.textContent = 'Aborted';
      agentStatusLabel.style.color  = 'var(--accent-red)';
      termLog('[ABORT] Stream cancelled by user.', true);
    });
  }

  // ── Ctrl+Enter shortcut ────────────────────────────────────────────
  document.getElementById('query').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      runForm.requestSubmit();
    }
  });

  // ── Run-agent form → SSE streaming ──────────────────────────────────────────
  runForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const query   = document.getElementById('query').value.trim();
    const seedUrl = document.getElementById('seed-url').value.trim();
    const skipN8n = document.getElementById('skip-n8n').checked;
    if (!query) return;

    if (activeSSE) { activeSSE.close(); activeSSE = null; }

    setRunning(true);
    termClear();
    reportContainer.classList.add('hidden');
    currentReportMarkdown = '';

    termLog('═'.repeat(50));
    termLog(`[CEREBRO OMEGA] Launching autonomous research agent`);
    termLog(`[Query]  "${query}"`);
    if (seedUrl) termLog(`[Seed]   ${seedUrl}`);
    termLog(`[n8n]    ${skipN8n ? 'webhook DISABLED' : 'webhook ENABLED'}`);
    termLog('═'.repeat(50));

    const p = new URLSearchParams({ query });
    if (seedUrl) p.set('seedUrl', seedUrl);
    if (skipN8n) p.set('skipN8n', '1');

    const es = new EventSource(`/api/run-agent-stream?${p}`);
    activeSSE = es;

    es.addEventListener('log', (ev) => {
      const { text, stderr } = JSON.parse(ev.data);
      termLog(text, stderr);
    });

    es.addEventListener('done', (ev) => {
      const data = JSON.parse(ev.data);
      es.close(); activeSSE = null;
      setRunning(false);

      if (data.success) {
        agentStatusLabel.textContent = 'Done ✓';
        agentStatusLabel.style.color  = 'var(--accent-green)';
        termLog('');
        termLog('═'.repeat(50));
        termLog(`[✓] Pages: ${data.pagesScraped}  Facts: ${data.factsCount}  n8n: ${data.webhookStatus}`);
        termLog('═'.repeat(50));

        if (data.report) {
          currentReportMarkdown = data.report;
          reportContentBody.innerHTML = renderMarkdown(data.report);
          reportContainer.classList.remove('hidden');
          termLog('[✓] Report compiled — see below ↓');
        }
        checkSystemStatus();   // refresh Qdrant fact count badge
      } else {
        agentStatusLabel.textContent = 'Failed ✗';
        agentStatusLabel.style.color  = 'var(--accent-red)';
        termLog(`[✗] ${data.error || 'Unknown error'}`, true);
      }
    });

    es.onerror = () => {
      es.close(); activeSSE = null;
      setRunning(false);
      agentStatusLabel.textContent = 'Connection lost';
      agentStatusLabel.style.color  = 'var(--accent-red)';
      termLog('[✗] SSE connection dropped', true);
    };
  });

  // ── Quick Crawl Tester ───────────────────────────────────────────────────────
  if (crawlTestForm) {
    crawlTestForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('crawl-test-url').value.trim();
      if (!url) return;
      const btn = crawlTestForm.querySelector('button');
      btn.disabled = true; btn.textContent = 'Crawling…';
      crawlTestResult.classList.add('hidden');
      try {
        const r = await fetch('/api/crawl-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const d = await r.json();
        crawlTestResult.classList.remove('hidden');
        if (d.success) {
          crawlTestResult.innerHTML = `
            <div class="crawl-result-ok">
              <p><strong>${escapeHtml(d.title)}</strong></p>
              <p class="crawl-meta">${(d.contentLength||0).toLocaleString()} chars &nbsp;|&nbsp; ${(d.links||[]).length} links found</p>
              <pre class="crawl-preview">${escapeHtml(d.preview)}${d.contentLength > 600 ? '\n…' : ''}</pre>
            </div>`;
        } else {
          crawlTestResult.innerHTML = `<p class="crawl-error">✗ ${escapeHtml(d.error)}</p>`;
        }
      } catch (err) {
        crawlTestResult.classList.remove('hidden');
        crawlTestResult.innerHTML = `<p class="crawl-error">✗ ${escapeHtml(err.message)}</p>`;
      } finally {
        btn.disabled = false; btn.textContent = 'Test Crawl';
      }
    });
  }

  // ── Copy / Export report ─────────────────────────────────────────────────────
  if (copyReportBtn) {
    copyReportBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(currentReportMarkdown || reportContentBody.innerText).then(() => {
        const o = copyReportBtn.textContent;
        copyReportBtn.textContent = '✓ Copied!';
        setTimeout(() => { copyReportBtn.textContent = o; }, 1500);
      });
    });
  }

  if (exportReportBtn) {
    exportReportBtn.addEventListener('click', () => {
      if (!currentReportMarkdown) return;
      const blob = new Blob([currentReportMarkdown], { type: 'text/markdown' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), { href: url, download: `cerebro-report-${Date.now()}.md` });
      a.click(); URL.revokeObjectURL(url);
    });
  }

  // ── Memory Grid ──────────────────────────────────────────────────────────────
  async function fetchFacts(forceRefresh = false) {
    factsGridBody.innerHTML = '<p class="subtitle">Connecting to Qdrant memory core…</p>';
    if (factsCountBadge) factsCountBadge.classList.add('hidden');
    try {
      const url = forceRefresh ? '/api/facts?refresh=1' : '/api/facts';
      const r = await fetch(url);
      allFacts = await r.json();
      if (!allFacts || !allFacts.length) {
        factsGridBody.innerHTML = '<p class="subtitle">No facts indexed yet. Run a research task first.</p>';
        return;
      }
      if (factsCountBadge) {
        factsCountBadge.textContent = allFacts.length;
        factsCountBadge.classList.remove('hidden');
      }
      renderFacts(allFacts);
    } catch (err) {
      factsGridBody.innerHTML = `<p class="subtitle" style="color:var(--accent-red)">Sync failed: ${escapeHtml(err.message)}</p>`;
    }
  }

  function renderFacts(list) {
    factsGridBody.innerHTML = '';
    if (!list.length) {
      factsGridBody.innerHTML = '<p class="subtitle">No matching facts.</p>';
      return;
    }
    list.forEach((fact, i) => {
      const card = document.createElement('div');
      card.className = 'fact-item';
      card.innerHTML = `
        <span class="fact-index">#${i + 1}</span>
        <p class="fact-text">${escapeHtml(fact.document)}</p>
        <a class="fact-source" href="${escapeHtml(fact.source)}" target="_blank" rel="noopener">↗ ${escapeHtml(fact.source)}</a>`;
      factsGridBody.appendChild(card);
    });
  }

  if (factsSearchInput) {
    factsSearchInput.addEventListener('input', (e) => {
      const kw = e.target.value.toLowerCase();
      renderFacts(allFacts.filter(f => (f.document || '').toLowerCase().includes(kw)));
    });
  }

  if (refreshFactsBtn) refreshFactsBtn.addEventListener('click', () => fetchFacts(true));

  // ── Run History ──────────────────────────────────────────────────────────────
  async function fetchHistory() {
    historyListBody.innerHTML = '<p class="subtitle">Loading history…</p>';
    try {
      const r = await fetch('/api/history');
      const runs = await r.json();
      if (!runs || !runs.length) {
        historyListBody.innerHTML = '<p class="subtitle">No previous runs found.</p>';
        return;
      }
      historyListBody.innerHTML = '';
      runs.forEach((run, idx) => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
          <div class="history-details">
            <h3>${escapeHtml(run.query)}</h3>
            <p>
              ${new Date(run.timestamp).toLocaleString()} 
              &nbsp;|&nbsp; Pages: ${run.pagesScraped ?? 0} 
              &nbsp;|&nbsp; Facts: ${run.factsCount ?? 0}
              ${run.webhookStatus ? `&nbsp;|&nbsp; Webhook: ${escapeHtml(run.webhookStatus)}` : ''}
            </p>
            ${run.seedUrl ? `<p class="history-seed">⤷ ${escapeHtml(run.seedUrl)}</p>` : ''}
            ${run.error   ? `<div class="history-error">${escapeHtml(run.error.slice(0, 250))}</div>` : ''}
          </div>
          <div class="history-actions">
            <span class="history-badge ${run.success ? 'badge-success' : 'badge-failed'}">${run.success ? 'Success' : 'Failed'}</span>
            ${run.report ? `<button class="secondary-btn expand-btn" data-idx="${idx}">View Report</button>` : ''}
          </div>`;
        historyListBody.appendChild(item);

        if (run.report) {
          const drawer = document.createElement('div');
          drawer.className = 'history-drawer hidden';
          drawer.id = `drawer-${idx}`;
          drawer.innerHTML = `<div class="report-content">${renderMarkdown(run.report)}</div>`;
          historyListBody.appendChild(drawer);
        }
      });

      // Single delegated listener
      historyListBody.addEventListener('click', (e) => {
        const btn = e.target.closest('.expand-btn');
        if (!btn) return;
        const drawer = document.getElementById(`drawer-${btn.dataset.idx}`);
        const open = !drawer.classList.contains('hidden');
        drawer.classList.toggle('hidden', open);
        btn.textContent = open ? 'View Report' : 'Hide Report';
      });

    } catch (err) {
      historyListBody.innerHTML = `<p class="subtitle" style="color:var(--accent-red)">Failed: ${escapeHtml(err.message)}</p>`;
    }
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', async () => {
      if (!confirm('Clear all execution history?')) return;
      await fetch('/api/history', { method: 'DELETE' });
      fetchHistory();
    });
  }

  // ── Markdown renderer ────────────────────────────────────────────────────────
  function renderMarkdown(md) {
    if (!md) return '';
    return md
      .replace(/```[\w]*\n([\s\S]*?)```/g, (_, c) => `<pre><code>${escapeHtml(c.trim())}</code></pre>`)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm,  '<h3>$1</h3>')
      .replace(/^## (.+)$/gm,   '<h2>$1</h2>')
      .replace(/^# (.+)$/gm,    '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,     '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/^- (.+)$/gm,    '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
      .replace(/^---$/gm,        '<hr>')
      .replace(/^(?!<[hupoclida]).+$/gm, line => line.trim() ? `<p>${line}</p>` : '');
  }

  // ── Computer Use Playground Logic ──────────────────────────────────────────

  // Elements
  const compForm = document.getElementById('computer-form');
  const compApiKeyInput = document.getElementById('computer-api-key');
  const compToggleKeyBtn = document.getElementById('computer-toggle-key-visibility');
  const compStartUrlInput = document.getElementById('computer-start-url');
  const compTaskInput = document.getElementById('computer-task-input');
  const compSimModeCheckbox = document.getElementById('computer-sim-mode');
  const compRunBtn = document.getElementById('computer-run-btn');
  const compAbortBtn = document.getElementById('computer-abort-btn');
  
  const compViewportImage = document.getElementById('computer-viewport-image');
  const compViewportUrl = document.getElementById('computer-viewport-url');
  const compMouseCursor = document.getElementById('computer-mouse-cursor');
  const compCanvasContainer = document.getElementById('computer-canvas-container');
  
  const compLiveStatsPanel = document.getElementById('computer-live-stats');
  const compStatSteps = document.getElementById('computer-stat-steps');
  const compStatTime = document.getElementById('computer-stat-time');
  const compStatStatus = document.getElementById('computer-stat-status');
  
  const compTimelineList = document.getElementById('computer-timeline-list');
  const compReportBox = document.getElementById('computer-report-box');
  const compReportContent = document.getElementById('computer-report-content');
  const compConsoleOutput = document.getElementById('computer-console-output');
  const compClearConsoleBtn = document.getElementById('computer-clear-console-btn');
  
  const compHistoryList = document.getElementById('computer-history-list');
  const compClearHistoryBtn = document.getElementById('computer-clear-history-btn');
  
  const compInspectCoordsHover = document.getElementById('computer-coords-hover');
  const compInspectCoordsClick = document.getElementById('computer-coords-click');
  const compInspectCopyVal = document.getElementById('computer-copy-val');
  const compInspectCopyBtn = document.getElementById('computer-copy-btn');
  const compInspectorTargetDot = document.getElementById('computer-target-dot');
  
  const compPlayPrevBtn = document.getElementById('computer-play-prev-btn');
  const compPlayToggleBtn = document.getElementById('computer-play-toggle-btn');
  const compPlayNextBtn = document.getElementById('computer-play-next-btn');
  const compPlaybackSpeedSelect = document.getElementById('computer-playback-speed');
  
  const compBadgeNode = document.getElementById('computer-badge-node');
  const compBadgePlaywright = document.getElementById('computer-badge-playwright');
  const compBadgeKey = document.getElementById('computer-badge-key');

  let compCurrentRunId = null;
  let compEventSource = null;
  let compStartTime = null;
  let compTimerInterval = null;
  let compActiveRunSteps = [];
  
  const COMP_LOCAL_STORAGE_KEY = 'computer_use_key';
  
  // Load API key from local storage
  if (localStorage.getItem(COMP_LOCAL_STORAGE_KEY)) {
    compApiKeyInput.value = localStorage.getItem(COMP_LOCAL_STORAGE_KEY);
  }
  
  compToggleKeyBtn.addEventListener('click', () => {
    if (compApiKeyInput.type === 'password') {
      compApiKeyInput.type = 'text';
      compToggleKeyBtn.textContent = '🔒';
    } else {
      compApiKeyInput.type = 'password';
      compToggleKeyBtn.textContent = '👁️';
    }
  });
  
  compApiKeyInput.addEventListener('input', () => {
    localStorage.setItem(COMP_LOCAL_STORAGE_KEY, compApiKeyInput.value.trim());
  });
  
  compClearConsoleBtn.addEventListener('click', () => {
    compConsoleOutput.innerHTML = '<span class="computer-sys-msg">[System] Console cleared.</span>';
  });
  
  function compAppendLog(text, isError = false) {
    const line = document.createElement('span');
    line.className = isError ? 'computer-log-err' : 'computer-log-line';
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    compConsoleOutput.appendChild(line);
    compConsoleOutput.scrollTop = compConsoleOutput.scrollHeight;
  }
  
  function compMoveCursor(x, y, actionType) {
    if (!x || !y) return;
    const percentX = (x / 1024) * 100;
    const percentY = (y / 768) * 100;
    
    compMouseCursor.classList.remove('hidden');
    compMouseCursor.style.left = `${percentX}%`;
    compMouseCursor.style.top = `${percentY}%`;
    
    if (actionType === 'click' || actionType === 'type') {
      const pulse = compMouseCursor.querySelector('.computer-click-pulse');
      pulse.classList.remove('animate');
      void pulse.offsetWidth;
      pulse.classList.add('animate');
    }
  }
  
  function compAddTimelineStep(step) {
    const card = document.createElement('div');
    card.className = 'computer-step-card';
    card.dataset.index = step.step;
    
    const stepNum = document.createElement('div');
    stepNum.className = 'computer-step-badge';
    stepNum.textContent = step.step;
    
    const stepMeta = document.createElement('div');
    stepMeta.className = 'computer-step-meta';
    
    const title = document.createElement('div');
    title.className = 'computer-step-title';
    title.textContent = step.action ? `Action: ${step.action.toUpperCase()}` : 'Observation';
    
    const desc = document.createElement('div');
    desc.className = 'computer-step-desc';
    desc.textContent = step.explanation || 'Examining environment screenshots';
    
    stepMeta.appendChild(title);
    stepMeta.appendChild(desc);
    
    const tag = document.createElement('div');
    tag.className = `computer-step-action-tag ${step.action || 'view'}`;
    tag.textContent = step.action || 'observe';
    
    card.appendChild(stepNum);
    card.appendChild(stepMeta);
    card.appendChild(tag);
    
    card.addEventListener('click', () => {
      document.querySelectorAll('.computer-step-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      compViewportImage.src = step.screenshot;
      if (step.coords) {
        compMoveCursor(step.coords[0], step.coords[1], step.action);
      } else {
        compMouseCursor.classList.add('hidden');
      }
    });
    
    compTimelineList.appendChild(card);
    document.querySelectorAll('.computer-step-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    compViewportImage.src = step.screenshot;
    
    if (step.coords) {
      compMoveCursor(step.coords[0], step.coords[1], step.action);
    } else {
      compMouseCursor.classList.add('hidden');
    }
    compTimelineList.scrollTop = compTimelineList.scrollHeight;
  }
  
  function compStartTimer() {
    compStartTime = Date.now();
    compTimerInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - compStartTime) / 1000);
      compStatTime.textContent = `${elapsed}s`;
    }, 1000);
  }
  
  function compStopTimer() {
    clearInterval(compTimerInterval);
  }
  
  async function compLoadHistory() {
    try {
      const res = await fetch('/api/computer/history');
      const data = await res.json();
      compHistoryList.innerHTML = '';
      if (data.length === 0) {
        compHistoryList.innerHTML = '<div class="computer-empty-timeline">No past sessions indexed.</div>';
        return;
      }
      data.forEach(run => {
        const item = document.createElement('div');
        item.className = 'computer-history-item';
        item.innerHTML = `
          <div class="computer-history-item-header">
            <span class="computer-history-time">${new Date(run.timestamp).toLocaleString()}</span>
            <span class="computer-history-status-badge ${run.success ? 'success' : 'failed'}">${run.success ? 'SUCCESS' : 'FAILED'}</span>
          </div>
          <div class="computer-history-task">${escapeHtml(run.task)}</div>
          <div class="computer-history-meta">
            <span>${run.isSimulation ? '🤖 Simulation' : '⚡ Live Agent'}</span>
            <span>Steps: ${run.stepsCount}</span>
          </div>`;
        item.addEventListener('click', () => {
          compLoadHistoricalRun(run);
        });
        compHistoryList.appendChild(item);
      });
    } catch (err) {
      console.error('Error fetching computer history:', err);
    }
  }
  
  function compLoadHistoricalRun(run) {
    compAppendLog(`[System] Loading historical run: ${run.runId}`);
    compViewportUrl.textContent = run.startUrl;
    compLiveStatsPanel.classList.remove('hidden');
    compStatSteps.textContent = run.stepsCount;
    compStatTime.textContent = '--';
    compStatStatus.textContent = 'Completed (Historical)';
    
    compTimelineList.innerHTML = '';
    if (run.steps && run.steps.length > 0) {
      run.steps.forEach(compAddTimelineStep);
      const firstCard = compTimelineList.querySelector('.computer-step-card');
      if (firstCard) firstCard.click();
    } else {
      compTimelineList.innerHTML = '<div class="computer-empty-timeline">No step details found.</div>';
      compViewportImage.src = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='768' viewBox='0 0 1024 768'><rect width='100%' height='100%' fill='%23181824'/><text x='50%' y='50%' font-family='sans-serif' font-size='22' fill='%23555577' text-anchor='middle'>No viewport capture available</text></svg>";
      compMouseCursor.classList.add('hidden');
    }
    
    if (run.finalReport) {
      compReportBox.classList.remove('hidden');
      compReportContent.innerHTML = renderMarkdown(run.finalReport);
    } else {
      compReportBox.classList.add('hidden');
    }
    
    compConsoleOutput.innerHTML = '';
    const lines = run.logs.split('\n');
    lines.forEach(l => {
      if (!l.trim()) return;
      const span = document.createElement('span');
      span.className = l.startsWith('[ERROR]') ? 'computer-log-err' : 'computer-sys-msg';
      span.textContent = l;
      compConsoleOutput.appendChild(span);
    });
    compConsoleOutput.scrollTop = compConsoleOutput.scrollHeight;
  }
  
  compClearHistoryBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to delete computer run history?')) {
      await fetch('/api/computer/history', { method: 'DELETE' });
      compLoadHistory();
      compTimelineList.innerHTML = '<div class="computer-empty-timeline">No agent steps recorded yet.</div>';
      compReportBox.classList.add('hidden');
      compLiveStatsPanel.classList.add('hidden');
    }
  });
  
  compAbortBtn.addEventListener('click', async () => {
    if (!compCurrentRunId) return;
    compAppendLog('[System] Sending cancellation command...');
    const res = await fetch('/api/computer/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: compCurrentRunId })
    });
    if (res.ok) {
      compAppendLog('[System] Agent execution aborted successfully.');
    } else {
      compAppendLog('[System] Failed to abort agent.', true);
    }
  });
  
  compForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const apiKey = compApiKeyInput.value.trim();
    const startUrl = compStartUrlInput.value.trim();
    const task = compTaskInput.value.trim();
    const isSim = compSimModeCheckbox.checked;
    
    if (!isSim && !apiKey) {
      alert('Please enter a valid Gemini API Key to run in Live Mode.');
      return;
    }
    
    compRunBtn.disabled = true;
    const spinner = compRunBtn.querySelector('.loader-spinner');
    if (spinner) spinner.classList.remove('hidden');
    compAbortBtn.classList.remove('hidden');
    
    compTimelineList.innerHTML = '';
    compReportBox.classList.add('hidden');
    compConsoleOutput.innerHTML = '<span class="computer-sys-msg">[System] Initializing secure agent session...</span>';
    
    compCurrentRunId = `run_${Date.now()}`;
    compActiveRunSteps = [];
    compViewportUrl.textContent = startUrl;
    compLiveStatsPanel.classList.remove('hidden');
    compStatSteps.textContent = '0';
    compStatStatus.textContent = 'Booting...';
    
    compStartTimer();
    
    try {
      const initRes = await fetch('/api/computer/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: compCurrentRunId,
          task,
          url: startUrl,
          sim: isSim,
          apiKey
        })
      });
      if (!initRes.ok) {
        const errData = await initRes.json();
        throw new Error(errData.error || 'Failed to initialize session.');
      }
      
      compAppendLog('[System] Secure session initialized. Establishing stream...');
      compEventSource = new EventSource(`/api/computer/stream-run?runId=${compCurrentRunId}`);
      
      compEventSource.addEventListener('log', (event) => {
        const data = JSON.parse(event.data);
        compAppendLog(data.text, data.error);
        if (compStatStatus.textContent === 'Booting...') {
          compStatStatus.textContent = 'Running';
        }
      });
      
      compEventSource.addEventListener('step', (event) => {
        const stepData = JSON.parse(event.data);
        compActiveRunSteps.push(stepData);
        compStatSteps.textContent = compActiveRunSteps.length;
        compAddTimelineStep(stepData);
        if (stepData.action === 'navigate' && stepData.text) {
          compViewportUrl.textContent = stepData.text;
        }
      });
      
      compEventSource.addEventListener('result', (event) => {
        const resultData = JSON.parse(event.data);
        compReportBox.classList.remove('hidden');
        compReportContent.innerHTML = renderMarkdown(resultData.report);
      });
      
      compEventSource.addEventListener('done', (event) => {
        const doneData = JSON.parse(event.data);
        compStopTimer();
        compAppendLog(`[System] Execution finished. Code: ${doneData.code}`);
        compStatStatus.textContent = doneData.success ? 'SUCCESS' : 'FINISHED (WARN)';
        
        compRunBtn.disabled = false;
        if (spinner) spinner.classList.add('hidden');
        compAbortBtn.classList.add('hidden');
        
        if (compEventSource) {
          compEventSource.close();
          compEventSource = null;
        }
        compLoadHistory();
      });
      
      compEventSource.onerror = () => {
        compStopTimer();
        compAppendLog('[System] EventSource connection dropped. Agent aborted.', true);
        compStatStatus.textContent = 'ERROR';
        compRunBtn.disabled = false;
        if (spinner) spinner.classList.add('hidden');
        compAbortBtn.classList.add('hidden');
        if (compEventSource) {
          compEventSource.close();
          compEventSource = null;
        }
        compLoadHistory();
      };
    } catch (err) {
      compStopTimer();
      compAppendLog(`[System] Error: ${err.message}`, true);
      compStatStatus.textContent = 'INIT_FAIL';
      compRunBtn.disabled = false;
      if (spinner) spinner.classList.add('hidden');
      compAbortBtn.classList.add('hidden');
      compLoadHistory();
    }
  });

  // Viewport Inspector listeners
  compViewportImage.addEventListener('mousemove', (e) => {
    const rect = compViewportImage.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1024);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 768);
    const clampX = Math.max(0, Math.min(1024, x));
    const clampY = Math.max(0, Math.min(768, y));
    compInspectCoordsHover.textContent = `Hover: (${clampX}, ${clampY})`;
  });

  compViewportImage.addEventListener('mouseleave', () => {
    compInspectCoordsHover.textContent = 'Hover: (--, --)';
  });

  compViewportImage.addEventListener('click', (e) => {
    const rect = compViewportImage.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1024);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 768);
    const clampX = Math.max(0, Math.min(1024, x));
    const clampY = Math.max(0, Math.min(768, y));
    const percentX = (clampX / 1024) * 100;
    const percentY = (clampY / 768) * 100;
    compInspectorTargetDot.classList.remove('hidden');
    compInspectorTargetDot.style.left = `${percentX}%`;
    compInspectorTargetDot.style.top = `${percentY}%`;
    compInspectCoordsClick.textContent = `Click: (${clampX}, ${clampY})`;
    compInspectCopyVal.value = `[${clampX}, ${clampY}]`;
  });

  compInspectCopyBtn.addEventListener('click', () => {
    if (!compInspectCopyVal.value) return;
    navigator.clipboard.writeText(compInspectCopyVal.value);
    const oldText = compInspectCopyBtn.textContent;
    compInspectCopyBtn.textContent = 'Copied!';
    setTimeout(() => { compInspectCopyBtn.textContent = oldText; }, 1000);
  });

  // Timeline slideshow playback
  let compPlaybackInterval = null;
  let compIsPlaying = false;

  function compPlayNextStep() {
    const cards = Array.from(compTimelineList.querySelectorAll('.computer-step-card'));
    if (cards.length === 0) return;
    const activeCard = compTimelineList.querySelector('.computer-step-card.active');
    let nextIndex = 0;
    if (activeCard) {
      const currentIndex = cards.indexOf(activeCard);
      nextIndex = (currentIndex + 1) % cards.length;
    }
    cards[nextIndex].click();
  }

  function compPlayPrevStep() {
    const cards = Array.from(compTimelineList.querySelectorAll('.computer-step-card'));
    if (cards.length === 0) return;
    const activeCard = compTimelineList.querySelector('.computer-step-card.active');
    let prevIndex = cards.length - 1;
    if (activeCard) {
      const currentIndex = cards.indexOf(activeCard);
      prevIndex = (currentIndex - 1 + cards.length) % cards.length;
    }
    cards[prevIndex].click();
  }

  function compTogglePlayback() {
    if (compIsPlaying) {
      clearInterval(compPlaybackInterval);
      compPlayToggleBtn.textContent = '⏯️';
      compIsPlaying = false;
      compAppendLog('[System] Slideshow playback paused.');
    } else {
      const cards = compTimelineList.querySelectorAll('.computer-step-card');
      if (cards.length === 0) return;
      compIsPlaying = true;
      compPlayToggleBtn.textContent = '⏸️';
      compAppendLog('[System] Starting slideshow auto-playback.');
      const intervalTime = parseInt(compPlaybackSpeedSelect.value, 10);
      compPlaybackInterval = setInterval(compPlayNextStep, intervalTime);
    }
  }

  compPlayToggleBtn.addEventListener('click', compTogglePlayback);
  compPlayNextBtn.addEventListener('click', compPlayNextStep);
  compPlayPrevBtn.addEventListener('click', compPlayPrevStep);
  compPlaybackSpeedSelect.addEventListener('change', () => {
    if (compIsPlaying) {
      clearInterval(compPlaybackInterval);
      const intervalTime = parseInt(compPlaybackSpeedSelect.value, 10);
      compPlaybackInterval = setInterval(compPlayNextStep, intervalTime);
    }
  });

  // Health checks
  async function checkComputerHealth() {
    try {
      const res = await fetch('/api/computer/status');
      const status = await res.json();
      
      compBadgeNode.querySelector('span:not(.computer-badge-dot)').textContent = `Node: ${status.status}`;
      compBadgeNode.querySelector('.computer-badge-dot').className = 'computer-badge-dot online';
      
      compBadgePlaywright.querySelector('span:not(.computer-badge-dot)').textContent = `Playwright: ${status.playwright}`;
      compBadgePlaywright.querySelector('.computer-badge-dot').className = `computer-badge-dot ${status.playwright === 'READY' ? 'online' : 'offline'}`;
      
      compBadgeKey.querySelector('span:not(.computer-badge-dot)').textContent = `API Key: ${status.apiKey === 'CONFIGURED' ? 'CONFIGURED' : 'NOT SET'}`;
      compBadgeKey.querySelector('.computer-badge-dot').className = `computer-badge-dot ${status.apiKey === 'CONFIGURED' ? 'configured' : 'offline'}`;
    } catch (err) {
      compBadgeNode.querySelector('span:not(.computer-badge-dot)').textContent = 'Node: OFFLINE';
      compBadgeNode.querySelector('.computer-badge-dot').className = 'computer-badge-dot offline';
      compBadgePlaywright.querySelector('span:not(.computer-badge-dot)').textContent = 'Playwright: OFFLINE';
      compBadgePlaywright.querySelector('.computer-badge-dot').className = 'computer-badge-dot offline';
      compBadgeKey.querySelector('span:not(.computer-badge-dot)').textContent = 'API Key: OFFLINE';
      compBadgeKey.querySelector('.computer-badge-dot').className = 'computer-badge-dot offline';
    }
  }

  // Load computer playground history on tab click
  document.querySelector('.nav-btn[data-tab="computer"]').addEventListener('click', () => {
    compLoadHistory();
    checkComputerHealth();
  });

});
