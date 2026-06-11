/**
 * Single-file dashboard page. No build step, no CDN dependencies —
 * everything inlined so it works on any server, even offline.
 * Data comes from /api/* endpoints, refreshed every 5 seconds.
 */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DLMM Buy Wall Tracker</title>
<style>
  :root {
    --bg: #0a0e17;
    --card: #111726;
    --card2: #0d1320;
    --border: #1e2738;
    --text: #e2e8f0;
    --muted: #64748b;
    --green: #22c55e;
    --green-dim: rgba(34,197,94,.12);
    --red: #ef4444;
    --red-dim: rgba(239,68,68,.12);
    --accent: #38bdf8;
    --yellow: #eab308;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    font-size: 14px;
    padding: 20px;
    max-width: 1280px;
    margin: 0 auto;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 12px; margin-bottom: 20px;
  }
  h1 { font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
  h2 { font-size: 14px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 12px; }
  .live {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 12px; color: var(--muted);
    background: var(--card); border: 1px solid var(--border);
    padding: 6px 12px; border-radius: 99px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
  .dot.pulse { animation: pulse 1.6s ease-in-out infinite; }
  .dot.dead { background: var(--red); animation: none; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 16px;
  }
  .card .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .07em; margin-bottom: 6px; }
  .card .value { font-size: 26px; font-weight: 700; line-height: 1.1; }
  .card .sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .card .value.green { color: var(--green); }

  .panel {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 16px; margin-bottom: 16px;
  }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } }

  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 11px; color: var(--muted);
    text-transform: uppercase; letter-spacing: .05em;
    padding: 8px 10px; border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td { padding: 10px; border-bottom: 1px solid var(--card2); vertical-align: middle; white-space: nowrap; }
  tr:hover td { background: var(--card2); }
  .table-wrap { overflow-x: auto; }

  .chip {
    display: inline-block; padding: 3px 10px; border-radius: 99px;
    font-size: 12px; font-weight: 600;
  }
  .chip.support { background: var(--green-dim); color: var(--green); }
  .chip.resistance { background: var(--red-dim); color: var(--red); }
  .sol { font-weight: 700; font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  .sym { font-weight: 700; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .links a { margin-right: 8px; font-size: 12px; }

  .dist { font-variant-numeric: tabular-nums; font-weight: 600; }
  .dist.tight { color: var(--green); }
  .dist.near { color: #86efac; }
  .dist.mid { color: var(--yellow); }
  .dist.far { color: var(--muted); }

  .filters { display: flex; gap: 8px; margin-bottom: 12px; }
  .fbtn {
    background: var(--card2); color: var(--muted); border: 1px solid var(--border);
    padding: 5px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; font-weight: 600;
  }
  .fbtn.active { background: var(--accent); color: #04121f; border-color: var(--accent); }

  .empty { color: var(--muted); padding: 28px 10px; text-align: center; font-size: 13px; }

  #chart { width: 100%; height: 120px; display: block; }
  .bar { fill: var(--green); opacity: .85; }
  .bar:hover { opacity: 1; }
  .bar.zero { fill: var(--border); }

  .statusgrid { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 13px; }
  .statusgrid .k { color: var(--muted); }
  .copy { cursor: pointer; opacity: .55; font-size: 11px; }
  .copy:hover { opacity: 1; }
  .act-row { padding: 8px 0; border-bottom: 1px solid var(--card2); font-size: 12px; display: flex; gap: 10px; align-items: baseline; }
  .act-time { color: var(--muted); flex-shrink: 0; width: 56px; }
  .act-ok { color: var(--green); }
  .act-no { color: var(--muted); }
  footer { color: var(--muted); font-size: 11px; text-align: center; padding: 16px 0 4px; }
</style>
</head>
<body>
<header>
  <h1>🧱 DLMM Buy Wall Tracker</h1>
  <span class="live"><span class="dot pulse" id="liveDot"></span><span id="liveText">Verbinde…</span></span>
</header>

<div class="cards">
  <div class="card"><div class="label">Buy Walls (24h)</div><div class="value" id="stCount24">–</div><div class="sub" id="stCount24Sub"></div></div>
  <div class="card"><div class="label">SOL-Volumen (24h)</div><div class="value green" id="stSol24">–</div><div class="sub">in erkannten Walls</div></div>
  <div class="card"><div class="label">Größte Wall (24h)</div><div class="value" id="stBiggest">–</div><div class="sub" id="stBiggestSub"></div></div>
  <div class="card"><div class="label">Gesamt erkannt</div><div class="value" id="stAll">–</div><div class="sub" id="stAllSol"></div></div>
</div>

<div class="panel">
  <h2>Walls pro Stunde (letzte 24h)</h2>
  <svg id="chart" preserveAspectRatio="none"></svg>
</div>

<div class="panel">
  <h2>Erkannte Walls</h2>
  <div class="filters">
    <button class="fbtn active" data-f="all">Alle</button>
    <button class="fbtn" data-f="below">🟢 Support</button>
    <button class="fbtn" data-f="above">🔴 Resistance</button>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Zeit</th><th>Token</th><th>Größe</th><th>Einseitig</th><th>Typ</th>
        <th>Distanz</th><th>Zone</th><th>Market Cap</th><th>Links</th>
      </tr></thead>
      <tbody id="wallsBody"></tbody>
    </table>
    <div class="empty" id="wallsEmpty" style="display:none">Noch keine Walls erkannt. Der Listener läuft und wertet jede neue DLMM-Position aus.</div>
  </div>
</div>

<div class="grid2">
  <div class="panel">
    <h2>🏆 Token-Leaderboard (24h)</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Token</th><th>Walls</th><th>Σ SOL</th><th>Größte</th></tr></thead>
        <tbody id="lbBody"></tbody>
      </table>
      <div class="empty" id="lbEmpty" style="display:none">Keine Daten in den letzten 24h.</div>
    </div>
  </div>
  <div class="panel">
    <h2>⚙️ Listener-Status</h2>
    <div class="statusgrid" id="statusGrid"></div>
    <h2 style="margin-top:18px">Letzte Aktivität</h2>
    <div id="activity"><div class="empty">Noch keine Positionen analysiert.</div></div>
  </div>
</div>

<footer>Aktualisiert alle 5s · Konzept: Einseitige SOL-Liquidität unter dem Preis = Kauf-Mauer (Support) → bullishes Signal</footer>

<script>
(function () {
  var token = new URLSearchParams(location.search).get("token") || "";
  var filter = "all";
  var lastData = null;

  function api(path) {
    var url = path + (token ? (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token) : "");
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function fmtSol(n) {
    if (n >= 1000) return (n / 1000).toFixed(2) + "K";
    return n >= 100 ? n.toFixed(0) : n.toFixed(1);
  }
  function fmtUsd(n) {
    if (!n || n <= 0) return "–";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + n.toFixed(2);
  }
  function rel(iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "vor " + Math.floor(s) + "s";
    if (s < 3600) return "vor " + Math.floor(s / 60) + "m";
    if (s < 86400) return "vor " + Math.floor(s / 3600) + "h";
    return "vor " + Math.floor(s / 86400) + "d";
  }
  function shortAddr(a) { return a ? a.slice(0, 4) + "…" + a.slice(-4) : "?"; }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function tierEmoji(sol) {
    if (sol >= 500) return "🐋"; if (sol >= 200) return "🦈";
    if (sol >= 100) return "🐬"; return "🐟";
  }
  function distClass(d) {
    if (d <= 1) return "tight"; if (d <= 3) return "near";
    if (d <= 10) return "mid"; return "far";
  }

  function renderStats(stats) {
    document.getElementById("stCount24").textContent = stats.last24h.count;
    document.getElementById("stCount24Sub").textContent = "alle: " + stats.allTime.count;
    document.getElementById("stSol24").textContent = fmtSol(stats.last24h.totalSol) + " SOL";
    document.getElementById("stBiggest").textContent =
      stats.last24h.biggestSol > 0 ? fmtSol(stats.last24h.biggestSol) + " SOL" : "–";
    document.getElementById("stBiggestSub").textContent =
      stats.last24h.biggestSol > 0 ? tierEmoji(stats.last24h.biggestSol) + " Tier" : "";
    document.getElementById("stAll").textContent = stats.allTime.count;
    document.getElementById("stAllSol").textContent = fmtSol(stats.allTime.totalSol) + " SOL gesamt";
    renderChart(stats.hourly);
    renderLeaderboard(stats.leaderboard);
  }

  function renderChart(hourly) {
    var svg = document.getElementById("chart");
    var W = 960, H = 120, pad = 2;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    var max = 1;
    hourly.forEach(function (b) { if (b.count > max) max = b.count; });
    var bw = W / hourly.length;
    var html = "";
    hourly.forEach(function (b, i) {
      var h = b.count > 0 ? Math.max(4, (b.count / max) * (H - 18)) : 2;
      var x = i * bw + pad;
      var y = H - h - 14;
      var hourLabel = new Date(b.hourIso).getHours();
      html += '<rect class="bar' + (b.count === 0 ? " zero" : "") + '" x="' + x + '" y="' + y +
        '" width="' + (bw - pad * 2) + '" height="' + h + '" rx="2"><title>' +
        hourLabel + ' Uhr: ' + b.count + ' Walls, ' + fmtSol(b.totalSol) + ' SOL</title></rect>';
      if (i % 4 === 0) {
        html += '<text x="' + (x + bw / 2) + '" y="' + (H - 2) + '" fill="#64748b" font-size="9" text-anchor="middle">' + hourLabel + 'h</text>';
      }
    });
    svg.innerHTML = html;
  }

  function renderLeaderboard(lb) {
    var body = document.getElementById("lbBody");
    var empty = document.getElementById("lbEmpty");
    if (!lb.length) { body.innerHTML = ""; empty.style.display = ""; return; }
    empty.style.display = "none";
    var html = "";
    lb.forEach(function (t, i) {
      var name = t.tokenSymbol ? esc(t.tokenSymbol) : '<span class="mono">' + shortAddr(t.tokenMint) + "</span>";
      html += "<tr><td class=\\"muted\\">" + (i + 1) + "</td>" +
        '<td><a href="https://dexscreener.com/solana/' + esc(t.tokenMint) + '" target="_blank" class="sym">' + name + "</a></td>" +
        "<td>" + t.wallCount + "</td>" +
        '<td class="sol">' + fmtSol(t.totalSol) + "</td>" +
        "<td>" + fmtSol(t.biggestSol) + " " + tierEmoji(t.biggestSol) + "</td></tr>";
    });
    body.innerHTML = html;
  }

  function renderWalls(walls) {
    var body = document.getElementById("wallsBody");
    var empty = document.getElementById("wallsEmpty");
    var rows = walls.filter(function (w) {
      return filter === "all" || w.rangeOrientation === filter;
    });
    if (!rows.length) { body.innerHTML = ""; empty.style.display = ""; return; }
    empty.style.display = "none";
    var html = "";
    rows.forEach(function (w) {
      var mint = w.solIsTokenY ? w.tokenXMint : w.tokenYMint;
      var sym = w.tokenSymbol ? esc(w.tokenSymbol) : shortAddr(mint);
      var isSupport = w.rangeOrientation === "below";
      var typeChip = isSupport
        ? '<span class="chip support">Support</span>'
        : '<span class="chip resistance">Resistance</span>';
      var d = w.metrics ? w.metrics.distancePct : 0;
      var depth = w.metrics ? w.metrics.depthPct : 0;
      var zone = isSupport
        ? "-" + d.toFixed(1) + "% bis -" + depth.toFixed(1) + "%"
        : "+" + d.toFixed(1) + "% bis +" + depth.toFixed(1) + "%";
      html += "<tr>" +
        '<td class="muted" title="' + esc(w.firstSeenAt) + '">' + rel(w.firstSeenAt) + "</td>" +
        '<td><span class="sym">' + sym + '</span> <span class="mono muted copy" data-copy="' + esc(mint) + '" title="Mint kopieren">' + shortAddr(mint) + " ⧉</span></td>" +
        '<td class="sol">' + tierEmoji(w.solValue) + " " + fmtSol(w.solValue) + " SOL</td>" +
        "<td>" + (w.solFraction * 100).toFixed(0) + "%</td>" +
        "<td>" + typeChip + "</td>" +
        '<td><span class="dist ' + distClass(d) + '">' + d.toFixed(1) + "%</span></td>" +
        '<td class="muted">' + zone + "</td>" +
        "<td>" + fmtUsd(w.marketCapUsd) + "</td>" +
        '<td class="links">' +
          '<a href="https://solscan.io/tx/' + esc(w.txSignature) + '" target="_blank">TX</a>' +
          '<a href="https://app.meteora.ag/dlmm/' + esc(w.lbPairAddress) + '" target="_blank">Pool</a>' +
          '<a href="https://dexscreener.com/solana/' + esc(mint) + '" target="_blank">Chart</a>' +
        "</td></tr>";
    });
    body.innerHTML = html;
  }

  function renderStatus(status) {
    var g = document.getElementById("statusGrid");
    var l = status.listener;
    var rows = [
      ["Tracker", status.enabled ? "✅ aktiviert" : "❌ deaktiviert (DLMM_BUYWALL_ENABLED)"],
      ["WebSocket", l && l.active ? "✅ verbunden" : "❌ getrennt"],
      ["Letztes Event", l ? "vor " + l.lastEventAgeSec + "s" : "–"],
      ["Reconnects", l ? String(l.reconnectAttempts) : "–"],
      ["TX analysiert", l ? String(l.counters.txAnalyzed) : "–"],
      ["Positionen geprüft", l ? String(l.counters.snapshotsProduced) : "–"],
      ["Uptime", Math.floor(status.uptimeSec / 3600) + "h " + Math.floor((status.uptimeSec % 3600) / 60) + "m"],
      ["Min. SOL", String(status.config.minSol)],
      ["Richtung", status.config.direction],
      ["Einseitig-Schwelle", (status.config.singleSideThreshold * 100).toFixed(0) + "%"]
    ];
    g.innerHTML = rows.map(function (r) {
      return '<span class="k">' + r[0] + "</span><span>" + r[1] + "</span>";
    }).join("");

    var dot = document.getElementById("liveDot");
    var txt = document.getElementById("liveText");
    if (status.enabled && l && l.active) {
      dot.classList.remove("dead");
      txt.textContent = "LIVE · " + new Date().toLocaleTimeString("de-DE");
    } else {
      dot.classList.add("dead");
      txt.textContent = status.enabled ? "Getrennt" : "Tracker deaktiviert";
    }
  }

  function renderActivity(items) {
    var el = document.getElementById("activity");
    if (!items.length) {
      el.innerHTML = '<div class="empty">Noch keine Positionen analysiert.</div>';
      return;
    }
    el.innerHTML = items.slice(0, 12).map(function (a) {
      var cls = a.matched ? "act-ok" : "act-no";
      var icon = a.matched ? "✅" : "·";
      return '<div class="act-row"><span class="act-time">' + rel(a.at) + "</span>" +
        '<span class="' + cls + '">' + icon + " " + fmtSol(a.solValue) + " SOL · " + esc(a.reason) + "</span></div>";
    }).join("");
  }

  function refresh() {
    Promise.all([api("/api/stats"), api("/api/walls"), api("/api/status"), api("/api/activity")])
      .then(function (res) {
        lastData = res;
        renderStats(res[0]);
        renderWalls(res[1].walls);
        renderStatus(res[2]);
        renderActivity(res[3].activity);
      })
      .catch(function () {
        var dot = document.getElementById("liveDot");
        dot.classList.add("dead");
        document.getElementById("liveText").textContent = "Keine Verbindung";
      });
  }

  document.querySelectorAll(".fbtn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".fbtn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      filter = btn.getAttribute("data-f");
      if (lastData) renderWalls(lastData[1].walls);
    });
  });

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains("copy")) {
      navigator.clipboard.writeText(t.getAttribute("data-copy"));
      var old = t.textContent;
      t.textContent = "kopiert ✓";
      setTimeout(function () { t.textContent = old; }, 1200);
    }
  });

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
