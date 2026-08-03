/* =========================================================
   DM INVEST — Scanner de Mercado
   100% client-side. Nenhuma dependência externa.
   Os preços são SIMULADOS (random walk) apenas para fins
   de demonstração visual do scanner de médias móveis.
   ========================================================= */

(function () {
  "use strict";

  // ---------- UNIVERSO DE ATIVOS ----------
  const ASSETS = [
    { symbol: "AAPL",  name: "Apple Inc.",         country: "US", base: 196.50 },
    { symbol: "MSFT",  name: "Microsoft Corp.",    country: "US", base: 431.20 },
    { symbol: "NVDA",  name: "NVIDIA Corp.",       country: "US", base: 138.75 },
    { symbol: "AMZN",  name: "Amazon.com Inc.",    country: "US", base: 186.40 },
    { symbol: "TSLA",  name: "Tesla Inc.",         country: "US", base: 251.90 },
    { symbol: "META",  name: "Meta Platforms",     country: "US", base: 503.10 },
    { symbol: "GOOGL", name: "Alphabet Inc.",      country: "US", base: 176.30 },
    { symbol: "PETR4", name: "Petrobras PN",       country: "BR", base: 38.42  },
    { symbol: "VALE3", name: "Vale ON",            country: "BR", base: 62.15  },
    { symbol: "ITUB4", name: "Itaú Unibanco PN",   country: "BR", base: 33.70  },
    { symbol: "BBDC4", name: "Bradesco PN",        country: "BR", base: 14.28  },
    { symbol: "BBAS3", name: "Banco do Brasil ON", country: "BR", base: 27.05  },
    { symbol: "WEGE3", name: "WEG ON",             country: "BR", base: 40.61  },
    { symbol: "MGLU3", name: "Magazine Luiza ON",  country: "BR", base: 2.14   },
  ];

  const TIMEFRAMES = ["1D", "1H", "15M"];
  const FLAGS = { BR: "🇧🇷", US: "🇺🇸" };
  const CURRENCY = { BR: "R$", US: "$" };

  // ---------- ESTADO ----------
  let dataset = [];              // resultado atual do scan
  let activeSignalFilter = "todos";
  let activeCountry = "todos";
  let activeTF = "1D";
  let alertsOnlyMode = false;

  // ---------- RNG (seedable, para variação a cada atualização) ----------
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- GERAÇÃO DE SÉRIE DE PREÇOS (random walk) ----------
  function generatePriceSeries(basePrice, points, rng, biasStrength) {
    const prices = [basePrice];
    // leve viés de tendência aleatório por série (alta, baixa ou lateral)
    const drift = biasStrength * (rng() - 0.42) * 0.0016;
    for (let i = 1; i < points; i++) {
      const noise = (rng() - 0.5) * basePrice * 0.012;
      const next = prices[i - 1] + drift * basePrice + noise;
      prices.push(Math.max(next, basePrice * 0.35));
    }
    return prices;
  }

  // ---------- MÉDIAS MÓVEIS ----------
  function smaAt(prices, period, endIndex) {
    if (endIndex + 1 < period) return null;
    let sum = 0;
    for (let i = endIndex - period + 1; i <= endIndex; i++) sum += prices[i];
    return sum / period;
  }

  function emaSeries(prices, period) {
    const n = prices.length;
    const out = new Array(n).fill(null);
    if (n < period) return out;
    const k = 2 / (period + 1);
    let seed = smaAt(prices, period, period - 1);
    out[period - 1] = seed;
    for (let i = period; i < n; i++) {
      seed = prices[i] * k + seed * (1 - k);
      out[i] = seed;
    }
    return out;
  }

  // ---------- CLASSIFICAÇÃO DE ALERTA ----------
  function classify(prices) {
    const n = prices.length;
    const last = n - 1;
    const price = prices[last];

    const ema9Series  = emaSeries(prices, 9);
    const ema20Series = emaSeries(prices, 20);
    const ema200Series = emaSeries(prices, Math.min(200, n - 1));
    const sma200 = smaAt(prices, Math.min(200, n - 1), last);
    const sma200Prev = smaAt(prices, Math.min(200, n - 1), Math.max(last - 5, 0));

    const ema9 = ema9Series[last];
    const ema20 = ema20Series[last];
    const ema200 = ema200Series[last];

    if (ema9 == null || ema20 == null || ema200 == null || sma200 == null) {
      return { status: "neutral", label: "Sem sinal", price, detail: "Histórico insuficiente" };
    }

    const sma200Rising = sma200 > sma200Prev;
    const priceAboveAll = price > ema9 && ema9 > 0;

    // ALERTA 1 — TENDÊNCIA FORTE
    const strongTrend =
      ema9 > ema20 &&
      ema20 > ema200 &&
      sma200Rising &&
      price > ema9 && price > ema20 && price > ema200;

    if (strongTrend) {
      return {
        status: "trend",
        label: "Tendência Forte",
        price,
        detail: "EMA9 > EMA20 > EMA200 · SMA200 em alta",
      };
    }

    // ALERTA 2 — PULLBACK
    const emaGapPct = Math.abs(ema9 - ema20) / ema20;
    const priceDistToShortAvgPct = Math.abs(price - ema20) / ema20;
    const distFromLongAvgPct = Math.abs(ema20 - ema200) / ema200;

    const emasAligned = emaGapPct < 0.006 && ema9 > 0 && ema20 > 0;
    const priceNearShortAvgs = priceDistToShortAvgPct < 0.012;
    const farFromLongAvg = distFromLongAvgPct > 0.03;

    const pullback = emasAligned && priceNearShortAvgs && farFromLongAvg && ema20 > ema200;

    if (pullback) {
      return {
        status: "pullback",
        label: "Pullback",
        price,
        detail: "EMA9/20 próximas do preço · distantes da EMA200",
      };
    }

    return {
      status: "neutral",
      label: "Sem sinal",
      price,
      detail: "Sem alinhamento de médias",
    };
  }

  // ---------- SCAN COMPLETO ----------
  function runScan() {
    const seed = Date.now() % 2147483647;
    const rng = mulberry32(seed);
    const result = [];

    ASSETS.forEach((asset, ai) => {
      TIMEFRAMES.forEach((tf, ti) => {
        const localRng = mulberry32(seed + ai * 977 + ti * 131);
        const points = 260;
        const biasStrength = 1 + localRng() * 2.2;
        const series = generatePriceSeries(asset.base, points, localRng, biasStrength);
        const prevSeries = series.slice(0, -3);
        const cls = classify(series);
        const prevPrice = prevSeries[prevSeries.length - 1];
        const changePct = ((cls.price - prevPrice) / prevPrice) * 100;

        result.push({
          symbol: asset.symbol,
          name: asset.name,
          country: asset.country,
          timeframe: tf,
          price: cls.price,
          changePct,
          status: cls.status,
          label: cls.label,
          detail: cls.detail,
        });
      });
    });

    return result;
  }

  // ---------- FORMATAÇÃO ----------
  function formatPrice(country, value) {
    const symbol = CURRENCY[country];
    return `${symbol} ${value.toFixed(country === "BR" && value < 10 ? 2 : 2)}`;
  }

  function badgeHTML(status, label) {
    if (status === "trend") return `<span class="badge badge-trend">📈 ${label}</span>`;
    if (status === "pullback") return `<span class="badge badge-pullback">⚠️ ${label}</span>`;
    return `<span class="badge badge-neutral">❌ ${label}</span>`;
  }

  // ---------- RENDER ----------
  function applyFilters(rows) {
    return rows.filter((r) => {
      if (r.timeframe !== activeTF) return false;
      if (activeCountry !== "todos" && r.country !== activeCountry) return false;

      if (alertsOnlyMode) {
        return r.status === "trend" || r.status === "pullback";
      }
      if (activeSignalFilter === "tendencia") return r.status === "trend";
      if (activeSignalFilter === "pullback") return r.status === "pullback";
      return true;
    });
  }

  function renderTable() {
    const tbody = document.getElementById("assetTableBody");
    const emptyState = document.getElementById("emptyState");
    const tableCount = document.getElementById("tableCount");
    const rows = applyFilters(dataset);

    // ordena: tendência primeiro, depois pullback, depois neutro
    const order = { trend: 0, pullback: 1, neutral: 2 };
    rows.sort((a, b) => order[a.status] - order[b.status] || a.symbol.localeCompare(b.symbol));

    tbody.innerHTML = "";

    if (rows.length === 0) {
      emptyState.style.display = "block";
    } else {
      emptyState.style.display = "none";
      rows.forEach((r) => {
        const tr = document.createElement("tr");
        tr.className = "row-enter";
        if (r.status === "trend") tr.classList.add("highlight-trend");
        if (r.status === "pullback") tr.classList.add("highlight-pullback");

        const changeClass = r.changePct >= 0 ? "up" : "down";
        const changeSign = r.changePct >= 0 ? "+" : "";

        tr.innerHTML = `
          <td class="cell-flag">${FLAGS[r.country]}</td>
          <td class="cell-asset">${r.symbol}<span class="asset-sub">${r.name}</span></td>
          <td><span class="cell-tf">${r.timeframe}</span></td>
          <td class="cell-price">${formatPrice(r.country, r.price)}</td>
          <td class="cell-change ${changeClass}">${changeSign}${r.changePct.toFixed(2)}%</td>
          <td>${badgeHTML(r.status, r.label)}</td>
          <td class="alert-type">${r.detail}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    tableCount.textContent = `${rows.length} ativo${rows.length === 1 ? "" : "s"}`;
  }

  function renderSummary() {
    const rowsForTF = dataset.filter((r) => r.timeframe === activeTF && (activeCountry === "todos" || r.country === activeCountry));
    const total = rowsForTF.length || 1;

    const trendCount = rowsForTF.filter((r) => r.status === "trend").length;
    const pullbackCount = rowsForTF.filter((r) => r.status === "pullback").length;
    const neutralCount = rowsForTF.filter((r) => r.status === "neutral").length;

    document.getElementById("countTrend").textContent = trendCount;
    document.getElementById("countPullback").textContent = pullbackCount;
    document.getElementById("countNeutral").textContent = neutralCount;

    document.getElementById("barTrend").style.width = `${(trendCount / total) * 100}%`;
    document.getElementById("barPullback").style.width = `${(pullbackCount / total) * 100}%`;
    document.getElementById("barNeutral").style.width = `${(neutralCount / total) * 100}%`;
  }

  function renderAll() {
    renderSummary();
    renderTable();
  }

  // ---------- RELÓGIO / STATUS DE MERCADO ----------
  function updateClock() {
    const now = new Date();
    document.getElementById("clock").textContent = now.toLocaleTimeString("pt-BR", { hour12: false });

    const day = now.getDay();
    const hour = now.getHours();
    const isWeekday = day >= 1 && day <= 5;
    const isOpenHours = hour >= 9 && hour < 18;
    const statusEl = document.getElementById("marketStatus");
    if (isWeekday && isOpenHours) {
      statusEl.textContent = "Aberto";
    } else {
      statusEl.textContent = "Fechado";
    }
  }

  // ---------- EVENTOS ----------
  function setupFilterButtons() {
    document.querySelectorAll("#signalFilters .filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        alertsOnlyMode = false;
        document.querySelectorAll("#signalFilters .filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeSignalFilter = btn.dataset.filter;
        document.getElementById("btnFilterAlerts").classList.remove("active-alerts");
        renderTable();
      });
    });

    document.querySelectorAll("#countryFilters .filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#countryFilters .filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeCountry = btn.dataset.country;
        renderAll();
      });
    });

    document.querySelectorAll("#tfFilters .tf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#tfFilters .tf-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeTF = btn.dataset.tf;
        renderAll();
      });
    });

    document.getElementById("btnRefresh").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      btn.classList.add("loading");
      btn.disabled = true;
      setTimeout(() => {
        dataset = runScan();
        renderAll();
        document.querySelectorAll(".table-section, .summary-grid").forEach((el) => {
          el.classList.remove("fade-refresh");
          void el.offsetWidth;
          el.classList.add("fade-refresh");
        });
        document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString("pt-BR", { hour12: false });
        btn.classList.remove("loading");
        btn.disabled = false;
      }, 500);
    });

    document.getElementById("btnFilterAlerts").addEventListener("click", (e) => {
      alertsOnlyMode = !alertsOnlyMode;
      e.currentTarget.classList.toggle("active-alerts", alertsOnlyMode);
      if (alertsOnlyMode) {
        document.querySelectorAll("#signalFilters .filter-btn").forEach((b) => b.classList.remove("active"));
      } else {
        document.querySelector('#signalFilters .filter-btn[data-filter="todos"]').classList.add("active");
        activeSignalFilter = "todos";
      }
      renderTable();
    });

    document.querySelectorAll(".nav-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        document.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));
        link.classList.add("active");
        const view = link.dataset.view;
        if (view === "alertas") {
          alertsOnlyMode = true;
          document.getElementById("btnFilterAlerts").classList.add("active-alerts");
          document.querySelectorAll("#signalFilters .filter-btn").forEach((b) => b.classList.remove("active"));
        } else if (view === "ativos") {
          alertsOnlyMode = false;
          activeSignalFilter = "todos";
          document.getElementById("btnFilterAlerts").classList.remove("active-alerts");
          document.querySelectorAll("#signalFilters .filter-btn").forEach((b) => b.classList.remove("active"));
          document.querySelector('#signalFilters .filter-btn[data-filter="todos"]').classList.add("active");
        } else {
          alertsOnlyMode = false;
          document.getElementById("btnFilterAlerts").classList.remove("active-alerts");
        }
        renderTable();
      });
    });
  }

  // ---------- INIT ----------
  function init() {
    dataset = runScan();
    setupFilterButtons();
    renderAll();
    document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString("pt-BR", { hour12: false });
    updateClock();
    setInterval(updateClock, 1000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
