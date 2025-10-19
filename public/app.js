const priceEl = document.getElementById('price');
const changeEl = document.getElementById('change');
const updatedAtEl = document.getElementById('updatedAt');
const chartStatusEl = document.getElementById('chartStatus');
const rangeSelect = document.getElementById('rangeSelect');
const intervalSelect = document.getElementById('intervalSelect');
const chartContainer = document.getElementById('goldChart');
const priceSymbolEl = document.getElementById('priceSymbol');
const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

const TEXT = {
  chartLibError: '\u65e0\u6cd5\u52a0\u8f7d\u56fe\u8868\u5e93\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u3002',
  loadingHistory: '\u6b63\u5728\u52a0\u8f7d\u5386\u53f2\u6570\u636e...',
  historyUnavailable: '\u6682\u65e0\u53ef\u7528\u7684\u5386\u53f2\u6570\u636e\u3002',
  historyFailed: '\u65e0\u6cd5\u52a0\u8f7d\u5386\u53f2\u6570\u636e\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
  priceUnavailable: '\u6682\u65e0\u6570\u636e',
  assistantThinking: '\u52a9\u624b\u6b63\u5728\u5206\u6790\u6700\u65b0\u884c\u60c5...',
  assistantNoReply: '\u52a9\u624b\u672a\u8fd4\u56de\u5185\u5bb9\u3002',
  assistantFailed: '\u65e0\u6cd5\u83b7\u53d6\u52a9\u624b\u56de\u590d\uff1a',
  initFailed: '\u5e94\u7528\u7a0b\u5e8f\u521d\u59cb\u5316\u5931\u8d25\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u91cd\u8bd5\u3002',
  chartStatusPrefix: '\u6570\u636e\u6e90\uff1a',
  chartStatusRange: '\u8303\u56f4',
  chartStatusInterval: '\u5468\u671f',
};

let chatSubmitButton;
let priceSnapshot = null;
let conversation = [];
let chart;
let candleSeries;
let latestChartContext = null;
let baselinePrice = null;
const REFRESH_INTERVAL_MS = 60_000; // 1 minute (fastest practical refresh for OKX public API)

function formatCurrency(value, currency = 'USD') {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--';
  }

  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

function formatChange(change, percent) {
  if (typeof change !== 'number' || Number.isNaN(change) || typeof percent !== 'number' || Number.isNaN(percent)) {
    changeEl.style.color = 'var(--text-muted)';
    return '--';
  }

  const sign = change >= 0 ? '+' : '';
  const color = change >= 0 ? 'var(--success)' : 'var(--danger)';
  changeEl.style.color = color;
  return `${sign}${change.toFixed(2)} (${sign}${percent.toFixed(2)}%)`;
}

async function refreshPrice() {
  try {
    const response = await fetch('/api/price', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    priceEl.textContent = formatCurrency(data.price, data.currency);

    if (Number.isFinite(data.price) && baselinePrice === null) {
      baselinePrice = data.price;
    }

    let changeValue = null;
    let changePercent = null;

    if (Number.isFinite(data.price) && Number.isFinite(baselinePrice) && baselinePrice !== 0) {
      changeValue = data.price - baselinePrice;
      changePercent = (changeValue / baselinePrice) * 100;
    } else if (Number.isFinite(data.change) && Number.isFinite(data.changePercent)) {
      changeValue = data.change;
      changePercent = data.changePercent;
    }

    changeEl.textContent = formatChange(changeValue, changePercent);

    if (priceSymbolEl) {
      const symbol = typeof data.symbol === 'string' ? data.symbol : 'XAUT-USDT';
      priceSymbolEl.textContent = symbol.replace('-', '/');
    }

    const timestamp = data.timestamp ? new Date(Number(data.timestamp)) : new Date();
    updatedAtEl.textContent = timestamp.toLocaleString('zh-CN', { hour12: false });

    priceSnapshot = {
      ...data,
      baselinePrice,
      changeFromBaseline: changeValue,
      changePercentFromBaseline: changePercent,
    };
  } catch (error) {
    console.error('refresh price failed', error);
    priceEl.textContent = TEXT.priceUnavailable;
    changeEl.textContent = '--';
    changeEl.style.color = 'var(--text-muted)';
    if (priceSymbolEl) {
      priceSymbolEl.textContent = '--';
    }
    updatedAtEl.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
  }
}

function initChart() {
  if (!window.LightweightCharts) {
    chartStatusEl.textContent = TEXT.chartLibError;
    return;
  }

  chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: chartContainer.clientHeight,
    layout: {
      background: { color: 'transparent' },
      textColor: '#e2e8f0',
    },
    grid: {
      horzLines: { color: 'rgba(148, 163, 184, 0.2)' },
      vertLines: { color: 'rgba(148, 163, 184, 0.15)' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    rightPriceScale: {
      borderVisible: false,
    },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
    },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#22c55e',
    downColor: '#f87171',
    borderUpColor: '#22c55e',
    borderDownColor: '#f87171',
    wickUpColor: '#22c55e',
    wickDownColor: '#f87171',
  });

  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === chartContainer) {
          const { width, height } = entry.contentRect;
          chart.applyOptions({ width, height });
        }
      }
    });
    resizeObserver.observe(chartContainer);
  } else {
    window.addEventListener('resize', () => {
      chart.applyOptions({
        width: chartContainer.clientWidth,
        height: chartContainer.clientHeight,
      });
    });
  }
}

async function loadHistory() {
  if (!chart || !candleSeries) {
    return;
  }

  const range = rangeSelect.value;
  const interval = intervalSelect.value;
  chartStatusEl.textContent = TEXT.loadingHistory;

  try {
    const response = await fetch(`/api/history?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const candles = (data.candles || [])
      .filter(item =>
        Number.isFinite(item?.open) &&
        Number.isFinite(item?.high) &&
        Number.isFinite(item?.low) &&
        Number.isFinite(item?.close) &&
        Number.isFinite(item?.time)
      )
      .map(item => ({
        time: Math.floor(Number(item.time) / 1000),
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close),
      }));

    if (candles.length === 0) {
      candleSeries.setData([]);
      chartStatusEl.textContent = TEXT.historyUnavailable;
      latestChartContext = null;
      return;
    }

    candleSeries.setData(
      candles.map(item => ({
        ...item,
        time: item.time + 8 * 60 * 60, // offset to GMT+8 (in seconds)
      }))
    );
    chart.timeScale().fitContent();

    const meta = data.meta ?? {};
    const symbolText = (meta.symbol ?? 'XAUT-USDT').replace('-', '/');
    chartStatusEl.textContent = `${TEXT.chartStatusPrefix}${symbolText} (${meta.exchange ?? 'OKX'}) | ${TEXT.chartStatusRange} ${range} | ${TEXT.chartStatusInterval} ${interval}`;

    latestChartContext = {
      meta: {
        symbol: meta.symbol ?? 'XAUT-USDT',
        exchange: meta.exchange ?? 'OKX',
        currency: meta.currency ?? 'USDT',
        interval: meta.interval ?? interval,
        range,
        pointCount: candles.length,
      },
      candles: candles
        .slice(-120)
        .map(item => ({
          time: item.time,
          open: Number(item.open.toFixed(2)),
          high: Number(item.high.toFixed(2)),
          low: Number(item.low.toFixed(2)),
          close: Number(item.close.toFixed(2)),
        })),
    };
  } catch (error) {
    console.error('load history failed', error);
    chartStatusEl.textContent = TEXT.historyFailed;
    latestChartContext = null;
  }
}

function appendMessage(role, content, { pending = false } = {}) {
  const bubble = document.createElement('div');
  bubble.classList.add('bubble', role);
  bubble.dataset.role = role;
  bubble.textContent = content;
  if (pending) {
    bubble.dataset.pending = 'true';
  }
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

function extractAssistantContent(reply) {
  if (!reply) {
    return TEXT.assistantNoReply;
  }
  if (typeof reply.content === 'string') {
    return reply.content.trim();
  }
  if (Array.isArray(reply.content)) {
    return reply.content
      .map(chunk => (typeof chunk === 'string' ? chunk : chunk?.text ?? ''))
      .join('')
      .trim();
  }
  return TEXT.assistantNoReply;
}

function setChatEnabled(enabled) {
  chatInput.disabled = !enabled;
  if (chatSubmitButton) {
    chatSubmitButton.disabled = !enabled;
  }
}

chatForm.addEventListener('submit', async event => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  appendMessage('user', text);
  conversation.push({ role: 'user', content: text });
  chatInput.value = '';
  setChatEnabled(false);

  const placeholder = appendMessage('assistant', TEXT.assistantThinking, { pending: true });

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conversation,
        priceSnapshot,
        chartContext: latestChartContext,
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload?.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const reply = data.reply;
    const content = extractAssistantContent(reply);
    placeholder.textContent = content;
    placeholder.dataset.pending = 'false';
    conversation.push({ role: reply?.role ?? 'assistant', content });
  } catch (error) {
    console.error('chat failed', error);
    placeholder.textContent = `${TEXT.assistantFailed}${error.message || error}`;
    placeholder.dataset.pending = 'false';
  } finally {
    setChatEnabled(true);
    chatInput.focus();
  }
});

function initChatUI() {
  chatSubmitButton = chatForm.querySelector('button[type="submit"]');
}

async function initialize() {
  initChatUI();
  initChart();
  await refreshPrice();
  await loadHistory();
  setInterval(refreshPrice, REFRESH_INTERVAL_MS);
  setInterval(loadHistory, REFRESH_INTERVAL_MS);
}

rangeSelect.addEventListener('change', loadHistory);
intervalSelect.addEventListener('change', loadHistory);

initialize().catch(error => {
  console.error('initialize failed', error);
  chartStatusEl.textContent = TEXT.initFailed;
});
