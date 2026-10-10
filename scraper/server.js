import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { exec, spawn } from 'child_process';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runScraper } from './crawler.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve dashboard static assets
app.use(express.static(path.join(projectRoot, 'public')));

// Path to history JSON file
const HISTORY_FILE = path.join(projectRoot, 'run_history.json');
const COMPUTER_HISTORY_FILE = path.join(projectRoot, 'computer_history.json');

// Validate runId to prevent path traversals (CWE-22)
const validateRunId = (runId) => {
  return typeof runId === 'string' && /^[a-zA-Z0-9_-]+$/.test(runId);
};

// Temp store for run parameters to avoid exposing keys in query strings (CWE-598)
const runParamsStore = new Map();

// Active computer processes map to allow cancellation
const activeComputerProcesses = new Map();

// Read computer run history (Asynchronous non-blocking)
const getComputerHistory = async () => {
  if (!fs.existsSync(COMPUTER_HISTORY_FILE)) return [];
  try {
    const data = await fs.promises.readFile(COMPUTER_HISTORY_FILE, 'utf-8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading computer history:', err);
    return [];
  }
};

// Save computer run history (Asynchronous non-blocking)
const saveComputerHistory = async (history) => {
  try {
    await fs.promises.writeFile(COMPUTER_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('Error writing computer history:', err);
  }
};

// Helper to read history file safely
const readHistory = () => {
  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Failed to read history file:', err);
    return [];
  }
};

// Helper to write history file safely
const saveHistory = (runData) => {
  try {
    const history = readHistory();
    history.unshift(runData); // prepend latest
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 50), null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write history file:', err);
  }
};

// ── In-process facts cache ─────────────────────────────────────────────────
// Avoids the ~9s Python cold-start on every Memory Grid load.
// Cache TTL: 5 minutes. Invalidated after each successful agent run.
const FACTS_CACHE_TTL_MS = 5 * 60 * 1000;
let factsCache = { data: null, ts: 0 };

const fetchFactsFromPython = () => new Promise((resolve, reject) => {
  const pythonPath     = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const getFactsScript = path.join(projectRoot, 'agent', 'get_facts.py');
  exec(
    `"${pythonPath}" "${getFactsScript}"`,
    { timeout: 30_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
    (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('JSON parse failed: ' + stdout.slice(0, 200))); }
    }
  );
});

const invalidateFactsCache = () => { factsCache = { data: null, ts: 0 }; };

// GET health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'cerebro-scraper-service' });
});

// Silence favicon 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// GET active LLM model name
app.get('/api/status/model', (req, res) => {
  const pythonPath  = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const statusScript = path.join(projectRoot, 'agent', 'status_model.py');
  exec(`"${pythonPath}" "${statusScript}"`, (err, stdout) => {
    if (err) return res.json({ model: 'unknown' });
    try { res.json(JSON.parse(stdout.trim())); } catch { res.json({ model: 'unknown' }); }
  });
});

// GET Qdrant local (file-based) status — cached for 60s to avoid cold-start flicker
const QDRANT_CACHE_TTL_MS = 60_000;
let qdrantCache = { data: null, ts: 0 };

app.get('/api/status/qdrant', (req, res) => {
  const pythonPath   = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const statusScript = path.join(projectRoot, 'agent', 'status_qdrant.py');

  const cacheAge = Date.now() - qdrantCache.ts;
  if (qdrantCache.data !== null && cacheAge < QDRANT_CACHE_TTL_MS) {
    return res.json(qdrantCache.data);
  }

  exec(
    `"${pythonPath}" "${statusScript}"`,
    { timeout: 20_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
    (err, stdout) => {
      if (err) {
        // Return stale cache if available
        if (qdrantCache.data) return res.json(qdrantCache.data);
        return res.json({ ok: false, error: 'exec failed' });
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        qdrantCache = { data: parsed, ts: Date.now() };
        res.json(parsed);
      } catch {
        res.json({ ok: false });
      }
    }
  );
});

// POST endpoint to trigger crawl
app.post('/crawl', async (req, res) => {
  const { url, maxPages } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing required field: "url"' });
  }

  try {
    const limit = parseInt(maxPages, 10) || 1;
    console.log(`Starting crawl task for: ${url} (maxPages: ${limit})`);
    const results = await runScraper(url, limit);
    
    res.json({
      success: true,
      url,
      pagesScrapedCount: results.length,
      pages: results
    });
  } catch (error) {
    console.error('Crawl task execution failed:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'An error occurred during crawling.'
    });
  }
});

// GET endpoint to retrieve facts from Qdrant via python exporter
app.get('/api/facts', async (req, res) => {
  const forceRefresh = req.query.refresh === '1';
  const cacheAge    = Date.now() - factsCache.ts;
  const cacheHit    = !forceRefresh && factsCache.data !== null && cacheAge < FACTS_CACHE_TTL_MS;

  console.log(`[/api/facts] forceRefresh=${forceRefresh}, cacheAge=${cacheAge}ms, cacheHit=${cacheHit}, hasData=${factsCache.data !== null}`);

  if (cacheHit) {
    res.setHeader('X-Facts-Cache', 'HIT');
    return res.json(factsCache.data);
  }

  try {
    const facts = await fetchFactsFromPython();
    factsCache = { data: facts, ts: Date.now() };
    res.setHeader('X-Facts-Cache', 'MISS');
    res.json(facts);
  } catch (err) {
    // If we have stale cache, return it rather than an error
    if (factsCache.data !== null) {
      res.setHeader('X-Facts-Cache', 'STALE');
      return res.json(factsCache.data);
    }
    console.error('[/api/facts] Error fetching:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET endpoint to fetch run history log
app.get('/api/history', (req, res) => {
  res.json(readHistory());
});

// DELETE endpoint to clear run history
app.delete('/api/history', (req, res) => {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2), 'utf-8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST quick crawl-test — scrapes a URL and returns the raw content immediately
app.post('/api/crawl-test', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const result = await runScraper(url, 1);
    if (result.length === 0) {
      return res.json({ success: false, error: 'No pages scraped (URL may be blocked or empty)' });
    }
    const page = result[0];
    res.json({
      success: true,
      url: page.url,
      title: page.title,
      contentLength: page.content.length,
      preview: page.content.slice(0, 600),
      links: page.links.slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── SSE streaming endpoint ─────────────────────────────────────────────────
// GET /api/run-agent-stream?query=...&seedUrl=...&skipN8n=1
// Streams Python stdout/stderr line-by-line as SSE events, then sends a
// final JSON "done" event with the parsed report/metrics.
app.get('/api/run-agent-stream', (req, res) => {
  const { query, seedUrl, skipN8n } = req.query;

  if (!query) {
    res.status(400).end('query param required');
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const pythonPath  = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const agentRunner = path.join(projectRoot, 'agent', 'run_agent.py');

  const child = spawn(pythonPath, [
    agentRunner, '--query', query,
    ...(seedUrl ? ['--seed-url', seedUrl] : []),
    ...(skipN8n === '1' || skipN8n === 'true' ? ['--skip-n8n'] : [])
  ], {
    cwd: projectRoot,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  });



  let fullStdout = '';
  let fullStderr = '';
  let lineBuffer = '';

  const flushLine = (chunk, isStderr) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.trim()) {
        send('log', { text: line, stderr: isStderr });
        fullStdout += line + '\n';
      }
    }
  };

  child.stdout.on('data', (data) => flushLine(data.toString(), false));
  child.stderr.on('data', (data) => {
    const text = data.toString();
    fullStderr += text;
    // Only forward non-Crawlee-INFO lines to keep terminal clean
    for (const line of text.split('\n')) {
      if (line.trim() && !line.startsWith('INFO ') && !line.includes('PlaywrightCrawler')) {
        send('log', { text: line, stderr: true });
      }
    }
  });

  child.on('close', (code) => {
    // Flush any remaining buffered line
    if (lineBuffer.trim()) {
      send('log', { text: lineBuffer, stderr: false });
      fullStdout += lineBuffer + '\n';
    }

    const success = code === 0;
    let pagesScraped = 0, factsCount = 0, report = '', webhookStatus = 'Not executed';

    if (success) {
      const scrapedMatch = fullStdout.match(/Pages Scraped:\s*(\d+)/i);
      if (scrapedMatch) pagesScraped = parseInt(scrapedMatch[1], 10);

      const factsMatch = fullStdout.match(/Facts Extracted:\s*(\d+)/i);
      if (factsMatch) factsCount = parseInt(factsMatch[1], 10);

      const reportPart = fullStdout.split('--- Final Research Report ---');
      if (reportPart.length > 1) {
        report = reportPart[1].split('--- Webhook Dispatch Status ---')[0].trim();
      }

      const webhookPart = fullStdout.split('--- Webhook Dispatch Status ---');
      if (webhookPart.length > 1) {
        webhookStatus = webhookPart[1].split('===================================')[0].replace('Status:', '').trim();
      }
    }

    // Persist to history
    saveHistory({
      timestamp: new Date().toISOString(),
      query,
      seedUrl: seedUrl || null,
      success,
      pagesScraped,
      factsCount,
      report: success ? report : null,
      webhookStatus: success ? webhookStatus : null,
      error: !success ? (fullStderr.slice(-400) || 'Execution crashed') : null
    });

    // Invalidate caches so status badges and Memory Grid show fresh data
    if (success) {
      invalidateFactsCache();
      qdrantCache = { data: null, ts: 0 };
    }

    send('done', { success, pagesScraped, factsCount, report, webhookStatus,
      error: !success ? fullStderr.slice(-400) : null });
    res.end();
  });

  // Cleanup if client disconnects early
  req.on('close', () => { try { child.kill(); } catch (_) {} });
});

// POST /api/run-agent — legacy JSON endpoint (kept for compatibility)
app.post('/api/run-agent', (req, finalRes) => {
  const { query, seedUrl, skipN8n } = req.body;

  if (!query) {
    return finalRes.status(400).json({ error: 'Query parameter is required' });
  }

  const pythonPath = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const agentRunner = path.join(projectRoot, 'agent', 'run_agent.py');
  
  let command = `"${pythonPath}" "${agentRunner}" --query "${query.replace(/"/g, '\\"')}"`;
  if (seedUrl) command += ` --seed-url "${seedUrl.replace(/"/g, '\\"')}"`;
  if (skipN8n) command += ` --skip-n8n`;

  console.log(`[Dashboard API] Launching agent command: ${command}`);

  exec(command, (error, stdout, stderr) => {
    const success = !error;
    let pagesScraped = 0, factsCount = 0, report = 'No report compiled.', webhookStatus = 'Not executed';

    if (success) {
      const scrapedMatch = stdout.match(/Pages Scraped:\s*(\d+)/i);
      if (scrapedMatch) pagesScraped = parseInt(scrapedMatch[1], 10);

      const factsMatch = stdout.match(/Facts Extracted:\s*(\d+)/i);
      if (factsMatch) factsCount = parseInt(factsMatch[1], 10);

      const reportPart = stdout.split('--- Final Research Report ---');
      if (reportPart.length > 1) report = reportPart[1].split('--- Webhook Dispatch Status ---')[0].trim();

      const webhookPart = stdout.split('--- Webhook Dispatch Status ---');
      if (webhookPart.length > 1) webhookStatus = webhookPart[1].split('===================================')[0].replace('Status:', '').trim();
    }

    saveHistory({
      timestamp: new Date().toISOString(),
      query,
      seedUrl: seedUrl || null,
      success,
      pagesScraped,
      factsCount,
      report: success ? report : null,
      webhookStatus: success ? webhookStatus : null,
      error: !success ? (stderr || 'Execution crashed') : null
    });

    if (!success) {
      console.error(`Agent runner crashed: ${stderr}`);
      return finalRes.status(500).json({ success: false, error: stderr || 'Execution crashed', stdout, stderr });
    }

    finalRes.json({ success: true, pagesScraped, factsCount, report, webhookStatus });
  });
});

// ── Computer Use Playground Routes ───────────────────────────────────────────

// POST /api/computer/run - Initialize secure session to avoid key exposure (CWE-598)
app.post('/api/computer/run', (req, res) => {
  const { runId, task, url, sim, apiKey } = req.body;
  if (!runId || !task) {
    return res.status(400).json({ success: false, error: 'runId and task are required.' });
  }
  if (!validateRunId(runId)) {
    return res.status(400).json({ success: false, error: 'Invalid runId format.' });
  }
  runParamsStore.set(runId, { task, url, sim: String(sim), apiKey });
  res.json({ success: true });
});

// GET /api/computer/stream-run - Stream computer agent execution via SSE
app.get('/api/computer/stream-run', (req, res) => {
  const { runId } = req.query;

  if (!runId || !validateRunId(runId)) {
    res.status(400).write('Invalid or missing runId query parameter.');
    res.end();
    return;
  }

  const params = runParamsStore.get(runId);
  if (!params) {
    res.status(404).write('Run parameters not found. Initialize via POST /api/run first.');
    res.end();
    return;
  }

  const { task, url, sim, apiKey } = params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Find python executable in the local virtual environment if present
  let pythonPath = 'python';
  const venvPythonWin = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const venvPythonUnix = path.join(projectRoot, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPythonWin)) {
    pythonPath = venvPythonWin;
  } else if (fs.existsSync(venvPythonUnix)) {
    pythonPath = venvPythonUnix;
  }

  const args = [
    path.join(projectRoot, 'agent.py'),
    '--task', task,
    '--run-id', runId,
    '--url', url || 'https://www.google.com'
  ];

  if (sim === 'true') {
    args.push('--sim');
  } else if (apiKey) {
    args.push('--api-key', apiKey);
  }

  console.log(`[Server] Spawning: ${pythonPath} ${args.join(' ')}`);

  const child = spawn(pythonPath, args, {
    cwd: projectRoot,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  });

  activeComputerProcesses.set(runId, child);

  let logs = '';
  let steps = [];
  let finalResult = null;

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'step') {
          steps.push(parsed);
          sendEvent('step', parsed);
        } else if (parsed.type === 'info') {
          sendEvent('log', { text: parsed.message });
          logs += `[INFO] ${parsed.message}\n`;
        } else if (parsed.type === 'result') {
          finalResult = parsed;
          sendEvent('result', parsed);
        } else if (parsed.type === 'error') {
          sendEvent('log', { text: `[ERROR] ${parsed.message}`, error: true });
          logs += `[ERROR] ${parsed.message}\n`;
        }
      } catch (err) {
        sendEvent('log', { text: line });
        logs += `${line}\n`;
      }
    }
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    sendEvent('log', { text: text, error: true });
    logs += `[STDERR] ${text}`;
  });

  child.on('close', async (code) => {
    activeComputerProcesses.delete(runId);
    runParamsStore.delete(runId);
    const success = code === 0 && (!finalResult || finalResult.status === 'success');
    
    // Create history entry
    const historyEntry = {
      runId,
      timestamp: new Date().toISOString(),
      task,
      startUrl: url || 'https://www.google.com',
      isSimulation: sim === 'true',
      success,
      stepsCount: steps.length,
      finalReport: finalResult ? finalResult.report : 'No report compiled.',
      steps: steps,
      logs: logs
    };

    const history = await getComputerHistory();
    history.unshift(historyEntry);
    await saveComputerHistory(history);

    sendEvent('done', { success, runId, code });
    res.end();
  });

  req.on('close', () => {
    runParamsStore.delete(runId);
    if (activeComputerProcesses.has(runId)) {
      console.log(`Client disconnected. Killing computer process for run ID: ${runId}`);
      try {
        child.kill();
      } catch (_) {}
      activeComputerProcesses.delete(runId);
    }
  });
});

// POST /api/computer/abort - Abort active computer run
app.post('/api/computer/abort', (req, res) => {
  const { runId } = req.body;
  if (!validateRunId(runId)) {
    return res.status(400).json({ success: false, error: 'Invalid runId format.' });
  }
  if (activeComputerProcesses.has(runId)) {
    const child = activeComputerProcesses.get(runId);
    try {
      child.kill();
      activeComputerProcesses.delete(runId);
      console.log(`Computer run ${runId} was aborted by user request.`);
      return res.json({ success: true, message: 'Process aborted successfully' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
  res.status(404).json({ success: false, error: 'No active process found for this run ID' });
});

// GET /api/computer/status - System diagnostics & health
app.get('/api/computer/status', (req, res) => {
  const hasApiKey = !!process.env.GEMINI_API_KEY;
  const venvPythonWin = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const venvPythonUnix = path.join(projectRoot, '.venv', 'bin', 'python');
  const pythonConfigured = fs.existsSync(venvPythonWin) || fs.existsSync(venvPythonUnix);
  
  res.json({
    status: 'ONLINE',
    python: pythonConfigured ? 'READY' : 'MISSING',
    playwright: pythonConfigured ? 'READY' : 'MISSING',
    apiKey: hasApiKey ? 'CONFIGURED' : 'NOT_CONFIGURED'
  });
});

// GET /api/computer/history - List history of computer runs
app.get('/api/computer/history', async (req, res) => {
  const history = await getComputerHistory();
  res.json(history);
});

// DELETE /api/computer/history - Clear history of computer runs
app.delete('/api/computer/history', async (req, res) => {
  await saveComputerHistory([]);
  const RUNS_DIR = path.join(projectRoot, 'public', 'runs');
  try {
    fs.rmSync(RUNS_DIR, { recursive: true, force: true });
    fs.mkdirSync(RUNS_DIR, { recursive: true });
  } catch (e) {
    console.error(e);
  }
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Scraper & Dashboard server listening at http://localhost:${PORT}`);
});

