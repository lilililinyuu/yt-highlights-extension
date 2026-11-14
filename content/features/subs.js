// 字幕下载（yt-dlp 同款原理）：获取字幕轨道列表（kind='asr' 为自动生成），
// 请求 fmt=json3（结构化优先格式），失败回退默认 XML，统一转换为 SRT 供下载。
// 轨道来源按可靠性排序（隔离世界直连 /player 可能被 PO Token 机制降级为无 captions）：
// ① MAIN 桥读页面当前的 ytInitialPlayerResponse（真实浏览器客户端的完整数据）
// ② 页面自身 /player 响应被动捕获（bridge fetch/XHR 钩子广播）
// ③ 直连 /player 接口（WEB 失败后换 TVHTML5 内嵌 / ANDROID 客户端，yt-dlp 同款绕过）
// ④ 重新拉取当前 watch 页 HTML，从内联 ytInitialPlayerResponse 提取
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};

  // —— 桥消息（与 innertube.js 同款 postMessage 模式）——

  let captionWaiter = null;      // { videoId, resolve, timer }
  let feedCache = null;          // 页面 /player 响应被动捕获：{ videoId, title, author, tracks, at }
  let ttextCache = null;         // 页面播放器加载的字幕：{ videoId, lang, kind, body, url, at }

  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.source !== 'ytex-bridge') return;
    if (d.type === 'captions' && captionWaiter && d.videoId === captionWaiter.videoId) {
      const { resolve } = captionWaiter;
      clearTimeout(captionWaiter.timer);
      captionWaiter = null;
      resolve(d.data || null);
    } else if (d.type === 'player-captions' && d.videoId && Array.isArray(d.tracks) && d.tracks.length) {
      feedCache = { videoId: d.videoId, title: d.title || '', author: d.author || '', tracks: d.tracks, at: Date.now() };
    } else if (d.type === 'ttext' && d.videoId && (d.body || d.url)) {
      const prev = ttextCache && ttextCache.videoId === d.videoId ? ttextCache : {};
      ttextCache = {
        videoId: d.videoId,
        lang: d.lang || prev.lang || '',
        kind: d.kind || prev.kind || '',
        body: d.body || prev.body || '',
        url: d.url || prev.url || '',   // 播放器的完整请求 URL（含 PO Token）
        at: Date.now(),
      };
    }
  });

  function viaBridge(videoId, timeoutMs = 1500) {
    return new Promise(resolve => {
      try {
        if (captionWaiter) {
          clearTimeout(captionWaiter.timer);
          const old = captionWaiter;
          captionWaiter = null;
          old.resolve(null);
        }
        const timer = setTimeout(() => { captionWaiter = null; resolve(null); }, timeoutMs);
        captionWaiter = { videoId, resolve, timer };
        window.postMessage({ source: 'ytex-content', type: 'get-captions', videoId }, '*');
      } catch { resolve(null); }
    });
  }

  // —— 轨道结构统一 ——
  // 内部形状：{ baseUrl, code, name, asr }；桥来的已是紧凑形状 { baseUrl, languageCode, kind, name }

  function normalizeTrack(t) {
    const code = t.languageCode || t.code || '';
    return {
      baseUrl: t.baseUrl,
      code,
      name: t.name || code,
      asr: (t.kind || '') === 'asr',
    };
  }

  function extractPlayerData(pr, vid) {
    const vd = (pr && pr.videoDetails) || {};
    const rs = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const tracks = ((rs && rs.captionTracks) || []).map(normalizeTrack).filter(t => t.baseUrl);
    return {
      videoId: vd.videoId || vid,
      title: vd.title || '',
      author: vd.author || '',
      tracks,
    };
  }

  // —— ③ 直连 player 接口（WEB → 内嵌/安卓客户端轮替）——

  const ALT_CLIENTS = [
    // TVHTML5 内嵌客户端：历史上无需 PO Token 即返回字幕（yt-dlp 常用兜底）
    { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' },
    { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30 },
  ];

  async function playerWithClient(videoId, altClient) {
    const cfg = await YTEX.innertube.getConfig();
    const ctxClient = (cfg.context && cfg.context.client) || {};
    const context = {
      ...(cfg.context || {}),
      client: { ...ctxClient, ...altClient, hl: ctxClient.hl, gl: ctxClient.gl },
    };
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(cfg.apiKey)}&prettyPrint=false`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, videoId, contentCheckOk: true, racyCheckOk: true }),
      }
    );
    if (!res.ok) throw new Error(`player(${altClient.clientName}) HTTP ${res.status}`);
    return res.json();
  }

  async function viaApi(videoId) {
    const candidates = [];
    try { candidates.push(await YTEX.innertube.player(videoId)); } catch {}
    for (const alt of ALT_CLIENTS) {
      // 已拿到轨道就不必再换客户端
      if (candidates.some(p => extractPlayerData(p, videoId).tracks.length)) break;
      try { candidates.push(await playerWithClient(videoId, alt)); } catch {}
    }
    for (const p of candidates) {
      const data = extractPlayerData(p, videoId);
      if (data.tracks.length) return data;
    }
    return null;
  }

  // —— ④ 页面 HTML 兜底：提取内联 ytInitialPlayerResponse（平衡括号扫描，防正则截断）——

  function extractJsonAfter(html, key) {
    const i = html.indexOf(key);
    if (i < 0) return null;
    const start = html.indexOf('{', i);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < html.length; j++) {
      const c = html[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) return html.slice(start, j + 1); }
    }
    return null;
  }

  async function viaHtml(videoId) {
    try {
      // 从 videoId 构造固定的 watch 页地址（与当前页硬刷新等价），不依赖可变 URL 输入
      const res = await fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(videoId), { credentials: 'same-origin' });
      if (!res.ok) return null;
      const raw = extractJsonAfter(await res.text(), 'ytInitialPlayerResponse');
      if (!raw) return null;
      const data = extractPlayerData(JSON.parse(raw), videoId);
      if (data.videoId && data.videoId !== videoId) return null;   // 防串页
      return data.tracks.length ? data : null;
    } catch { return null; }
  }

  // 汇集所有来源的轨道（fetchSrt 备选池用）：桥 → 页面捕获 → WEB → 内嵌/安卓 → HTML
  async function collectAll(videoId) {
    const out = [];
    const push = data => { if (data && data.tracks && data.tracks.length) out.push(data); };
    const fromBridge = await viaBridge(videoId);
    if (fromBridge && fromBridge.tracks && fromBridge.tracks.length
        && (!fromBridge.videoId || fromBridge.videoId === videoId)) {
      push({ videoId, title: fromBridge.title || '', tracks: fromBridge.tracks.map(normalizeTrack) });
    }
    if (feedCache && feedCache.videoId === videoId) {
      push({ videoId, title: feedCache.title, tracks: feedCache.tracks.map(normalizeTrack) });
    }
    try { push(await YTEX.innertube.player(videoId).then(p => extractPlayerData(p, videoId))); } catch {}
    for (const alt of ALT_CLIENTS) {
      try { push(extractPlayerData(await playerWithClient(videoId, alt), videoId)); } catch {}
    }
    try { push(await viaHtml(videoId)); } catch {}
    return out;
  }

  // 拉取字幕轨道列表（baseUrl 含时效参数，需在下载前实时获取）
  async function listTracks(videoId) {
    if (!videoId) return { tracks: [], title: '', author: '' };
    // ① 页面当前的 ytInitialPlayerResponse（最可靠：与真实播放器同源）
    const fromBridge = await viaBridge(videoId);
    if (fromBridge && fromBridge.tracks && fromBridge.tracks.length
        && (!fromBridge.videoId || fromBridge.videoId === videoId)) {
      return { videoId, title: fromBridge.title || '', author: fromBridge.author || '', tracks: fromBridge.tracks.map(normalizeTrack) };
    }
    // ② 页面 /player 响应被动捕获
    if (feedCache && feedCache.videoId === videoId && feedCache.tracks.length) {
      return { videoId, title: feedCache.title, author: feedCache.author || '', tracks: feedCache.tracks.map(normalizeTrack) };
    }
    // ③ 直连 player 接口（含客户端轮替）
    const fromApi = await viaApi(videoId);
    if (fromApi) {
      return fromApi;
    }
    // ④ watch 页 HTML 内联数据
    const fromHtml = await viaHtml(videoId);
    if (fromHtml) {
      return fromHtml;
    }
    // 全部未命中：确实无可用的字幕轨道
    return { tracks: [], title: '', author: '' };
  }

  function srtTime(ms) {
    const t = Math.max(0, Math.round(ms));
    const h = Math.floor(t / 3600000);
    const m = Math.floor((t % 3600000) / 60000);
    const s = Math.floor((t % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(t % 1000).padStart(3, '0')}`;
  }

  // json3 → SRT：events 即逐条字幕；附录事件（aAppend，音轨说明等）与空行跳过
  function json3ToSrt(data) {
    let out = '';
    let idx = 1;
    for (const ev of data.events || []) {
      if (ev.aAppend) continue;
      const text = ((ev.segs || []).map(sg => sg.utf8).join('')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start = ev.tStartMs || 0;
      const dur = ev.dDurationMs || 2000;
      out += `${idx}\n${srtTime(start)} --> ${srtTime(start + dur)}\n${text}\n\n`;
      idx++;
    }
    return out;
  }

  // XML（srv1：<text start="12.34" dur="1.05">…</text>）→ SRT：旧版回退格式
  function xmlToSrt(xmlText) {
    let out = '';
    let idx = 1;
    const re = /<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
    for (const m of xmlText.matchAll(re)) {
      const start = Math.round(parseFloat(m[1]) * 1000);
      const dur = Math.round(parseFloat(m[2] || '2') * 1000);
      const text = decodeEntities(m[3]).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out += `${idx}\n${srtTime(start)} --> ${srtTime(start + dur)}\n${text}\n\n`;
      idx++;
    }
    return out;
  }

  // 新版 timedtext XML（srv3：<timedtext><body><p t="1200" d="2800"><s>…</s></p>）→ SRT
  function timedtextToSrt(xmlText) {
    if (!/<timedtext/i.test(xmlText)) return '';
    let out = '';
    let idx = 1;
    for (const m of xmlText.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      const attr = (name, fallback) => {
        const am = m[1].match(new RegExp(`\\b${name}="(\\d+)"`));
        return am ? Number(am[1]) : fallback;
      };
      const start = attr('t', 0);
      const dur = attr('d', 2000);
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out += `${idx}\n${srtTime(start)} --> ${srtTime(start + dur)}\n${text}\n\n`;
      idx++;
    }
    return out;
  }

  // WebVTT → SRT（fmt=vtt：结构与 SRT 最接近，兜底最稳）
  function vttToSrt(vtt) {
    const cueRe = /((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3})/;
    let out = '';
    let idx = 1;
    for (const block of vtt.replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n');
      const ti = lines.findIndex(l => cueRe.test(l));
      if (ti < 0) continue;
      const m = lines[ti].match(cueRe);
      const text = lines.slice(ti + 1).join(' ')
        .replace(/<[^>]+>/g, '')            // 去内联标签（<c>、<00:00:01.000> 词级时间等）
        .replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out += `${idx}\n${vttTime(m[1])} --> ${vttTime(m[2])}\n${text}\n\n`;
      idx++;
    }
    return out;
  }

  // VTT 时间 → SRT 时间（补齐 HH:MM:SS,mmm；VTT 可能是 MM:SS.mmm 或用 . 作毫秒分隔）
  function vttTime(t) {
    const parts = t.replace(',', '.').split(':');
    const [h, m, s] = parts.length === 3 ? parts : ['0', parts[0], parts[1]];
    const [sec, ms] = s.split('.');
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${(sec || '0').padStart(2, '0')},${(ms || '0').padEnd(3, '0').slice(0, 3)}`;
  }

  function decodeEntities(s) {
    return String(s)
      .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (mm, name) => ({
        amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ',
      })[name] || mm)
      .replace(/&#(\d+);/g, (mm, n) => {
        try { return String.fromCodePoint(Number(n)); } catch { return mm; }
      });
  }

  // 生成指定 fmt 的 timedtext URL：先剥离 baseUrl 中已有的 fmt 参数（服务端只认第一个 fmt，
  // 直接追加会导致要的格式不生效——这正是此前"下载失败：empty"的根因）
  function withFmt(baseUrl, fmt) {
    let u = baseUrl.replace(/([?&])fmt=[^&]*/g, '$1').replace(/&&+/g, '&').replace(/[?&]+$/, '');
    if (!fmt) return u;
    return u + (u.includes('?') ? '&' : '?') + 'fmt=' + fmt;
  }

  // 从播放器的 timedtext 请求 URL 提取可复用的参数尾（PO Token + 客户端参数）。
  // F12 实测两种场景：
  // · 有 pot：potc/pot 是必需参数（无 pot 一律 200 空正文）；
  // · 无 pot：c=WEB/cver/cplayer/cos 等客户端参数是必需参数（用户实测播放器请求不带 pot 也成功）。
  // 因此无论有没有 pot，都把整套客户端参数拼回目标轨道的 baseUrl。
  const CLIENT_PARAMS = ['potc', 'pot', 'xorb', 'xobt', 'xovt', 'cbr', 'cbrver', 'c', 'cver', 'cplayer', 'cos', 'cosver', 'cplatform'];
  function clientTailOf(playerUrl) {
    try {
      const u = new URL(playerUrl, 'https://www.youtube.com/');
      const tail = CLIENT_PARAMS
        .filter(k => u.searchParams.get(k))
        .map(k => `${k}=${encodeURIComponent(u.searchParams.get(k))}`)
        .join('&');
      return tail ? '&' + tail : '';
    } catch { return ''; }
  }

  // 直接重放播放器的 timedtext URL（含完整生效参数），换 lang/kind 即可取目标轨道。
  // 实测换 lang 参数有效（签名不覆盖 lang）。
  function replayUrlFor(playerUrl, track, fmt) {
    try {
      const u = new URL(playerUrl, 'https://www.youtube.com/');
      if (track && track.code) u.searchParams.set('lang', track.code);
      if (track && track.asr) u.searchParams.set('kind', 'asr');
      else u.searchParams.delete('kind');
      u.searchParams.delete('tlang');       // 去掉可能的翻译参数
      u.searchParams.set('fmt', fmt || 'json3');
      return u.toString();
    } catch { return ''; }
  }

  // 内容自动识别并转 SRT（页面缓存正文格式未知：json3 / WebVTT / XML 均可）
  function parseAny(raw) {
    const s = String(raw || '').replace(/^\uFEFF/, '').trimStart();
    if (s.startsWith('{')) {
      try { return json3ToSrt(JSON.parse(s)); } catch {}
      // 截断的 JSON（缓存上限裁断）：逐个抢救完整的事件对象
      return salvageJson3(s);
    }
    if (/^WEBVTT/i.test(s)) return vttToSrt(s);
    return timedtextToSrt(s) || xmlToSrt(s);
  }

  // 从被截断的 json3 文本中抢救完整 events：平衡括号扫描，逐个解析
  function salvageJson3(s) {
    const i = s.indexOf('"events"');
    if (i < 0) return '';
    const arrStart = s.indexOf('[', i);
    if (arrStart < 0) return '';
    let out = '';
    let idx = 1;
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    for (let j = arrStart + 1; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth === 0) start = j; depth++; }
      else if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            const ev = JSON.parse(s.slice(start, j + 1));
            const text = ((ev.segs || []).map(sg => sg.utf8).join('')).replace(/\s+/g, ' ').trim();
            if (text && !ev.aAppend) {
              const st = ev.tStartMs || 0;
              const dur = ev.dDurationMs || 2000;
              out += `${idx}\n${srtTime(st)} --> ${srtTime(st + dur)}\n${text}\n\n`;
              idx++;
            }
          } catch {}
          start = -1;
        }
      }
    }
    return out;
  }

  // 单一 baseUrl 的格式回退链：json3 → vtt → 默认 XML（srv1/srv3 双格式）
  // potTail：来自播放器请求的 PO Token 客户端参数（可选，则裸拉）
  async function fetchWithFallback(track, potTail) {
    // baseUrl 来自解析的页面 JSON，兜底校验只允许 YouTube 官方域（防被改写的数据引向任意外部地址）
    const u = new URL(track.baseUrl, location.href);
    if (u.protocol !== 'https:' || !/(^|\.)youtube\.com$/.test(u.hostname)) {
      throw new Error('非 YouTube 字幕地址，已拒绝请求');
    }
    const attempts = [
      ['json3', raw => json3ToSrt(JSON.parse(raw))],
      ['vtt', raw => vttToSrt(raw)],
      [null, raw => timedtextToSrt(raw) || xmlToSrt(raw)],
    ];
    let lastErr = '';
    for (const [fmt, convert] of attempts) {
      try {
        const res = await fetch(withFmt(u.href, fmt) + (potTail || ''));
        if (!res.ok) {
          lastErr = `fmt=${fmt || 'xml'} HTTP ${res.status}`;
          continue;
        }
        const raw = await res.text();
        const srt = convert(raw);
        if (srt) return srt;
        lastErr = `fmt=${fmt || 'xml'} 内容为空`;
      } catch (e) {
        lastErr = `fmt=${fmt || 'xml'} ${String((e && e.message) || e)}`;
      }
    }
    throw new Error(lastErr || 'empty');
  }

  function dedupeByUrl(tracks) {
    const seen = new Set();
    return (tracks || []).filter(t => t && t.baseUrl && !seen.has(t.baseUrl) && seen.add(t.baseUrl));
  }

  // 兜底 pot 来源：直接扫页面性能时间线。播放器发出的所有 timedtext 请求（含 pot 参数）
  // 都会留在 performance resource 条目里——即使 fetch/XHR 钩子没截到（如 Worker 内发起）也逃不掉。
  function potUrlFromPerf(videoId) {
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name || '';
        if (name.includes('/api/timedtext') && name.includes('pot=') && (!videoId || name.includes(`v=${videoId}`))) {
          return name;
        }
      }
    } catch {}
    return '';
  }

  // 下载某轨道并转成 SRT 文本。
  // timedtext 生效参数有两种实测场景：有 pot 时 potc/pot 必需；无 pot 时
  // c=WEB/cver/cplayer 等客户端参数必需（用户环境实测）。播放器自己的请求两者都带齐了，
  // 因此首选直接重放播放器 URL（换 lang/kind 取目标轨道），其次把客户端参数拼到 baseUrl 上。
  async function fetchSrt(track, videoId) {
    if (!track || !track.baseUrl) throw new Error('no baseUrl');
    const cc = ttextCache && (!videoId || ttextCache.videoId === videoId) ? ttextCache : null;
    // 缓存新鲜度：捕获时间超过 10 分钟的 URL/正文视为过期（签名/pot 可能已轮换），不参与快路径
    const ccFresh = cc && cc.at && (Date.now() - cc.at) < 10 * 60 * 1000;
    // ⓪ 页面已加载的同一字幕：优先"重放捕获的完整请求"（全新抓取，无截断风险）。
    // 过期缓存不参与，避免用过期签名请求拿到空正文。
    if (cc && ccFresh && cc.url && (!track.code || !cc.lang || cc.lang === track.code)) {
      for (const fmt of ['json3', 'vtt']) {
        try {
          const u = new URL(cc.url, 'https://www.youtube.com/');
          u.searchParams.set('fmt', fmt);
          const res = await fetch(u.toString());
          if (!res.ok) continue;
          const srt = parseAny(await res.text());
          if (srt) return srt;
        } catch {}
      }
    }
    if (cc && ccFresh && cc.body && cc.body.length < 7900000
        && (!track.code || !cc.lang || cc.lang === track.code)) {
      const srt = parseAny(cc.body);
      if (srt) return srt;
    }
    // 播放器 URL：CC 捕获优先，其次性能时间线扫描
    let playerUrl = (cc && cc.url) || '';
    let potSrc = cc && cc.url ? 'CC捕获' : '';
    if (!playerUrl) {
      playerUrl = potUrlFromPerf(videoId);
      potSrc = playerUrl ? '性能时间线' : '';
    }
    const clientTail = playerUrl ? clientTailOf(playerUrl) : '';
    // ① 直接重放播放器 URL（换 lang/kind）——参数集已验证可用
    if (playerUrl) {
      for (const fmt of ['json3', 'vtt']) {
        try {
          const url = replayUrlFor(playerUrl, track, fmt);
          const res = await fetch(url);
          const raw = await res.text();
          const srt = res.ok ? parseAny(raw) : '';
          if (srt) return srt;
        } catch (e) {
        }
      }
    }
    // ② 目标轨道 baseUrl（+客户端参数 → 裸）→ ③ 备用轨道同样处理
    const candidates = [{ t: track, label: '' }];
    if (videoId) {
      let pools = [];
      try { pools = await collectAll(videoId); } catch (e) {
      }
      const rest = dedupeByUrl(pools.flatMap(src => src.tracks)).filter(t => t.baseUrl !== track.baseUrl);
      for (const [i, t] of [
        ...rest.filter(t => t.code === track.code && t.asr === track.asr),
        ...rest.filter(t => t.code === track.code && t.asr !== track.asr),
        ...rest.filter(t => t.code !== track.code),
      ].entries()) {
        candidates.push({ t, label: `备用轨道${i + 1}：` });
      }
    }
    const seen = new Set();
    const uniq = candidates.filter(c => c.t.baseUrl && !seen.has(c.t.baseUrl) && seen.add(c.t.baseUrl)).slice(0, 6);
    let lastErr = '';
    for (const { t: cand, label } of uniq) {
      for (const tail of clientTail ? [clientTail, ''] : ['']) {
        try {
          return await fetchWithFallback(cand, tail);
        } catch (e) {
          lastErr = `${label}${String((e && e.message) || e)}`;
        }
      }
    }
    console.warn('[YTEX][subs] 全部尝试失败。最后错误:', lastErr);
    throw new Error(`${lastErr || 'empty'}（提示：打开播放器下方的 CC 字幕开关，等几秒后再点下载——扩展会借用播放器自己拿到的字幕数据与请求参数）`);
  }

  YTEX.subs = { listTracks, fetchSrt };
})();
