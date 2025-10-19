const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const HTTP_PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : null;
const HTTPS_PORT = Number(process.env.HTTPS_PORT || process.env.PORT || 3443);
const OKX_TICKER_URL = 'https://www.okx.com/api/v5/market/ticker';
const OKX_CANDLE_URL = 'https://www.okx.com/api/v5/market/candles';
const OKX_INSTRUMENT = process.env.OKX_INSTRUMENT || 'XAUT-USDT';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

const INTERVAL_MAP = {
  '5m': { bar: '5m', minutes: 5 },
  '15m': { bar: '15m', minutes: 15 },
  '30m': { bar: '30m', minutes: 30 },
  '1h': { bar: '1H', minutes: 60 },
  '1d': { bar: '1D', minutes: 1440 },
};

const RANGE_TO_DAYS = {
  '1d': 1,
  '5d': 5,
  '1mo': 30,
  '3mo': 90,
  '6mo': 180,
};

async function fetchJson(url, { headers = {}, timeout = 10_000, depth = 6 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (err) {
    if (!isWindows) {
      throw err;
    }
    console.warn(`Primary fetch failed for ${url}: ${err.message}. Falling back to PowerShell.`);
    return await fetchJsonViaPowerShell(url, headers, depth, timeout);
  } finally {
    clearTimeout(timer);
  }
}

function escapeForPowerShell(value) {
  return String(value).replace(/'/g, "''");
}

async function fetchJsonViaPowerShell(url, headers, depth, timeout) {
  const headerEntries = Object.entries(headers || {});
  const psLines = [];

  if (headerEntries.length) {
    psLines.push('$headers = @{};');
    headerEntries.forEach(([key, value]) => {
      psLines.push(`$headers['${escapeForPowerShell(key)}'] = '${escapeForPowerShell(value)}';`);
    });
  }

  const headersArg = headerEntries.length ? ' -Headers $headers' : '';
  const script = [
    headerEntries.length ? psLines.join('\n') : '$headers = $null;',
    `$response = Invoke-RestMethod -Uri '${escapeForPowerShell(url)}'${headersArg};`,
    `$response | ConvertTo-Json -Depth ${depth};`,
  ].join('\n');

  const execTimeout = timeout + 5_000;
  const { stdout, stderr } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
    timeout: execTimeout,
    windowsHide: true,
  });

  const cleaned = stdout.trim().replace(/^\uFEFF/, '');
  if (!cleaned) {
    throw new Error(`PowerShell fallback returned no data${stderr ? `: ${stderr}` : ''}`);
  }

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    throw new Error(`Failed to parse PowerShell JSON output: ${parseErr.message}`);
  }
}

function roundToTwo(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(2));
}

function sanitizeChartContext(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const { meta, candles } = input;
  if (!Array.isArray(candles) || candles.length === 0) {
    return null;
  }

  const trimmedCandles = candles
    .slice(-120)
    .map(entry => {
      const epochSeconds = Number(entry?.time);
      const open = roundToTwo(Number(entry?.open));
      const high = roundToTwo(Number(entry?.high));
      const low = roundToTwo(Number(entry?.low));
      const close = roundToTwo(Number(entry?.close));

      if (!Number.isFinite(epochSeconds) || [open, high, low, close].some(value => value === null)) {
        return null;
      }

      return {
        time: new Date(epochSeconds * 1000).toISOString(),
        open,
        high,
        low,
        close,
      };
    })
    .filter(Boolean);

  if (trimmedCandles.length === 0) {
    return null;
  }

  const sanitizedMeta = {};
  if (meta && typeof meta === 'object') {
    if (meta.symbol) sanitizedMeta.symbol = String(meta.symbol);
    if (meta.exchange) sanitizedMeta.exchange = String(meta.exchange);
    if (meta.currency) sanitizedMeta.currency = String(meta.currency);
    if (meta.interval) sanitizedMeta.interval = String(meta.interval);
    if (meta.range) sanitizedMeta.range = String(meta.range);
    if (Number.isFinite(Number(meta.pointCount))) sanitizedMeta.pointCount = Number(meta.pointCount);
  }

  sanitizedMeta.candlesProvided = trimmedCandles.length;

  return { meta: sanitizedMeta, candles: trimmedCandles };
}

function resolvePathMaybe(filePath) {
  if (!filePath) {
    return null;
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(process.cwd(), filePath);
}

function readTlsFile(label, filePath) {
  const resolved = resolvePathMaybe(filePath);
  if (!resolved) {
    return null;
  }
  try {
    return fs.readFileSync(resolved);
  } catch (err) {
    console.error(`Failed to read ${label} at ${resolved}:`, err.message);
    return null;
  }
}

function buildTlsOptions() {
  const keyFile = process.env.TLS_KEY_FILE;
  const certFile = process.env.TLS_CERT_FILE;

  if (!keyFile || !certFile) {
    return null;
  }

  const key = readTlsFile('TLS key', keyFile);
  const cert = readTlsFile('TLS certificate', certFile);

  if (!key || !cert) {
    console.warn('TLS key or certificate could not be loaded; HTTPS server will not start.');
    return null;
  }

  const tlsOptions = { key, cert };

  if (process.env.TLS_PASSPHRASE) {
    tlsOptions.passphrase = process.env.TLS_PASSPHRASE;
  }

  const caFiles = (process.env.TLS_CA_FILE || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => readTlsFile('TLS CA bundle', entry))
    .filter(Boolean);

  if (caFiles.length) {
    tlsOptions.ca = caFiles;
  }

  return tlsOptions;
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/price', async (req, res) => {
  const query = new URLSearchParams({ instId: OKX_INSTRUMENT });

  try {
    const payload = await fetchJson(`${OKX_TICKER_URL}?${query.toString()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GoldMonitor/1.0; +https://example.com)',
        Accept: 'application/json',
      },
      timeout: 10_000,
      depth: 4,
    });
    const ticker = payload?.data?.[0];

    if (!ticker) {
      throw new Error(`Unexpected OKX ticker payload: ${JSON.stringify(payload)}`);
    }

    const last = Number(ticker.last);
    const open24h = Number(ticker.open24h);
    const high24h = Number(ticker.high24h);
    const low24h = Number(ticker.low24h);
    const volume24h = Number(ticker.volCcy24h ?? ticker.vol24h);

    const change = Number.isFinite(last) && Number.isFinite(open24h)
      ? last - open24h
      : null;
    const changePercent = Number.isFinite(change) && Number.isFinite(open24h) && open24h !== 0
      ? (change / open24h) * 100
      : null;

    res.json({
      price: Number.isFinite(last) ? last : null,
      open24h: Number.isFinite(open24h) ? open24h : null,
      high24h: Number.isFinite(high24h) ? high24h : null,
      low24h: Number.isFinite(low24h) ? low24h : null,
      volume24h: Number.isFinite(volume24h) ? volume24h : null,
      change,
      changePercent,
      currency: 'USD',
      quoteCurrency: 'USDT',
      symbol: OKX_INSTRUMENT,
      exchange: 'OKX',
      timestamp: Number(ticker.ts) || Date.now(),
    });
  } catch (err) {
    console.error('Price fetch error:', err.message);
    res.status(502).json({ error: 'Failed to retrieve gold price' });
  }
});

app.get('/api/history', async (req, res) => {
  const range = req.query.range || '5d';
  const interval = (req.query.interval || '15m').toLowerCase();

  const intervalConfig = INTERVAL_MAP[interval];
  if (!intervalConfig) {
    return res.status(400).json({ error: 'Unsupported interval' });
  }

  const days = RANGE_TO_DAYS[range] ?? RANGE_TO_DAYS['5d'];
  const estimatedCandles = Math.ceil((days * 1440) / intervalConfig.minutes);
  const limit = Math.max(50, Math.min(estimatedCandles, 300)); // OKX limit range 1-300

  const query = new URLSearchParams({
    instId: OKX_INSTRUMENT,
    bar: intervalConfig.bar,
    limit: String(limit),
  });

  try {
    const payload = await fetchJson(`${OKX_CANDLE_URL}?${query.toString()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GoldMonitor/1.0; +https://example.com)',
        Accept: 'application/json',
      },
      timeout: 10_000,
      depth: 4,
    });
    if (payload?.code !== '0' || !Array.isArray(payload?.data)) {
      throw new Error(`Unexpected OKX payload: ${JSON.stringify(payload)}`);
    }

    const candles = payload.data
      .map(entry => ({
        time: Number(entry?.[0]),
        open: Number(entry?.[1]),
        high: Number(entry?.[2]),
        low: Number(entry?.[3]),
        close: Number(entry?.[4]),
        volume: Number(entry?.[5]),
      }))
      .filter(candle =>
        Number.isFinite(candle.time) &&
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close)
      )
      .sort((a, b) => a.time - b.time);

    res.json({
      meta: {
        currency: 'USDT',
        symbol: OKX_INSTRUMENT,
        exchange: 'OKX',
        interval: intervalConfig.bar,
        rangeDays: days,
      },
      candles,
    });
  } catch (err) {
    console.error('History fetch error:', err.message);
    res.status(502).json({ error: 'Failed to retrieve historical data' });
  }
});

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'LLM API key is not configured on the server.' });
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const temperature = Number.isFinite(Number(process.env.OPENAI_TEMPERATURE))
    ? Number(process.env.OPENAI_TEMPERATURE)
    : 0.3;

  const { messages, priceSnapshot, chartContext } = req.body || {};
  const finalMessages = [];

  finalMessages.push({
    role: 'system',
    content: 'You are an analytical assistant who explains gold market moves, reads candlestick patterns, and answers trading questions clearly and cautiously. If you lack data, state that instead of guessing. Never give financial advice without clear disclaimers.',
  });

  if (priceSnapshot) {
    finalMessages.push({
      role: 'system',
      content: `Latest market snapshot: ${JSON.stringify(priceSnapshot)}`,
    });
  }

  const cleanedChartContext = sanitizeChartContext(chartContext);
  if (cleanedChartContext) {
    finalMessages.push({
      role: 'system',
      content: `Latest displayed candlesticks (ISO time, newest last): ${JSON.stringify(cleanedChartContext)}`,
    });
  }

  if (Array.isArray(messages)) {
    finalMessages.push(...messages);
  } else {
    return res.status(400).json({ error: 'Request body must include a messages array.' });
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: finalMessages,
        temperature,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Chat upstream failed:', response.status, errorBody);
      return res.status(response.status).json({ error: 'LLM upstream error', details: errorBody });
    }

    const payload = await response.json();
    const reply = payload?.choices?.[0]?.message;

    if (!reply) {
      throw new Error('LLM payload missing choices');
    }

    res.json({ reply, usage: payload.usage ?? null });
  } catch (err) {
    console.error('Chat proxy error:', err.message);
    res.status(502).json({ error: 'Failed to contact language model provider' });
  }
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

if (Number.isFinite(HTTP_PORT) && HTTP_PORT > 0) {
  const httpServer = http.createServer(app);
  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP server listening on http://0.0.0.0:${HTTP_PORT}`);
  });
} else {
  console.log('HTTP server disabled (set PORT to enable plain HTTP).');
}

const tlsOptions = buildTlsOptions();
if (tlsOptions) {
  https.createServer(tlsOptions, app).listen(HTTPS_PORT, () => {
    console.log(`HTTPS server listening on https://0.0.0.0:${HTTPS_PORT}`);
  });
} else {
  console.log('HTTPS server not started. Provide TLS_KEY_FILE and TLS_CERT_FILE to enable TLS.');
  if (!Number.isFinite(HTTP_PORT) || HTTP_PORT <= 0) {
    console.warn('Warning: no HTTP or HTTPS listener is active. Configure TLS or set PORT.');
  }
}
