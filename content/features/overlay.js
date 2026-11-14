// 笑点曲线叠加层：鼠标悬停视频进度条（或面板本身）时，在时间轴上方显示半透明迷你曲线。
// 粉=笑点、蓝=留言、白色虚线=当前播放位置（仅圆点模式不画位置虚线）；悬停显示该时段留言/发笑条数；
// 点击/拖动面板可直接跳转对应时间。深色背景与折线的透明度分别可调，
// 开关与两个透明度在「笑点曲线」页设置（本地持久化），调节时叠加层自动出现供预览。
// 通过 YTEX.overlay.setEnabled/setBgOpacity/setLineOpacity/preview 由面板实时下发。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};
  const I = (k, ...a) => YTEX.i18n.t(k, ...a);

  let box = null;            // 叠加层容器（挂在 #movie_player 里）
  let canvas = null;
  let tip = null;            // 悬停数据提示
  let bgOpacity = 0.72;      // 深色背景透明度（持久化：ytexOverlayBgOpacity）
  let lineOpacity = 0.55;    // 折线透明度（持久化：ytexOverlayOpacity）
  let enabled = true;        // 是否启用叠加（持久化：ytexOverlayEnabled）
  let hoverIdx = -1;         // 当前悬停的桶下标
  let pointHover = null;     // 当前悬停的时间戳行（圆点命中时非空）
  let tsDots = true;         // 是否在曲线上显示时间戳圆点（持久化：ytexOverlayTsDots）
  let dotMinGap = 0;         // 圆点最小间距 px（密集时抽稀，优先保留点赞高的；0=全显。持久化：ytexOverlayDotGap）
  let dotsOnly = false;      // 仅圆点模式：总开关关、圆点开（draw/applyStyle 按此切换）
  let scrubbing = false;     // 正在面板内拖动跳转
  let previewUntil = 0;      // 设置调节时的强制预览截止时刻
  let previewTimer = 0;
  let dotsMissLogged = false;   // 圆点悬停未命中的一次性诊断（只报一次，避免刷屏）
  let heatStyle = null;      // 强制保留原生「重放最多」热力图的注入样式（仅注入一次）

  // YouTube 原生热力图容器默认 display:none / height:0，仅在播放器悬停进度条
  // （.ytp-progress-bar-hover）时显示，且波形 svg 高度也只在悬停态给出。
  // 我们的叠加层接管指针后悬停态丢失，热力图随之淡出——因此叠加层显示期间
  // （圆点开关开启时）用 :has() 门控复刻悬停态，让原生热力图一直可见。
  function ensureHeatStyle() {
    if (heatStyle) return;
    heatStyle = document.createElement('style');
    heatStyle.textContent =
      '#movie_player:not(.ad-showing):has(> .ytex-overlay-box.ytex-overlay-on) .ytp-heat-map-container' +
      '{display:block!important;opacity:1!important;height:40px!important;bottom:5px!important}' +
      '#movie_player:not(.ad-showing):has(> .ytex-overlay-box.ytex-overlay-on) .ytp-heat-map-chapter svg' +
      '{height:40px!important}';
    (document.head || document.documentElement).appendChild(heatStyle);
  }
  // 按圆点开关 + 叠加层是否正在显示，同步热力图保留门控。
  // 强制保留仅在曲线模式（叠加层接管指针）下生效；仅圆点模式交给原生悬停行为。
  function syncHeatMarker() {
    if (!box) return;
    box.classList.toggle('ytex-overlay-on', enabled && tsDots && box.style.display !== 'none');
  }

  const fmtT = sec => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
  };

  function getData() {
    return YTEX.panel && YTEX.panel.getChartData ? YTEX.panel.getChartData() : null;
  }

  function applyStyle() {
    dotsOnly = !enabled && tsDots;   // 集中推导：任何开关变更都经此同步背景
    if (box) {
      // 仅圆点模式：背景与外框全部透明，只显示圆点（不画位置虚线/悬停线）
      box.style.background = dotsOnly ? 'transparent' : `rgba(0, 0, 0, ${bgOpacity})`;
      box.style.border = dotsOnly ? 'none' : '1px solid rgba(255, 255, 255, .25)';
      box.style.borderRadius = dotsOnly ? '0' : '8px';
      // 仅圆点模式不拦截指针：原生悬停预览（缩略图/时间）照常工作，说明文字注入原生预览卡
      box.style.pointerEvents = dotsOnly ? 'none' : 'auto';
    }
    if (canvas) {
      canvas.style.opacity = String(lineOpacity);
      canvas.style.pointerEvents = dotsOnly ? 'none' : 'auto';
    }
    if (!dotsOnly) hideDotsHint();
  }

  function ensureBox(player) {
    if (box && box.isConnected && box.__player === player) return box;
    if (box) box.remove();
    box = document.createElement('div');
    box.className = 'ytex-overlay-box';
    box.__player = player;
    Object.assign(box.style, {
      position: 'absolute',
      left: '12px',
      right: '12px',
      bottom: '52px',
      height: '110px',
      borderRadius: '8px',
      pointerEvents: 'auto',          // 面板本身可交互（悬停查数/点击跳转），不会误消失
      zIndex: '59',
      display: 'none',
      overflow: 'hidden',
      background: 'transparent',
      border: 'none',
    });
    applyStyle();   // 按 dots-only/完整模式补上背景与边框
    canvas = document.createElement('canvas');
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', cursor: 'pointer' });
    box.appendChild(canvas);
    tip = document.createElement('div');
    Object.assign(tip.style, {
      position: 'absolute',
      top: '4px',
      left: '6px',
      maxWidth: 'calc(100% - 12px)',
      width: 'max-content',   // 固有内容宽：宽度不随 left/可用空间反馈变化（否则尾部悬停时框会越变越宽或收窄换行）
      padding: '3px 8px',
      borderRadius: '6px',
      background: 'rgba(20, 20, 20, .92)',
      color: '#fff',
      fontSize: '11px',
      lineHeight: '1.5',
      whiteSpace: 'pre-line',   // 保留时间戳说明里的换行（多行描述逐行显示），超宽自动折行
      pointerEvents: 'none',
      display: 'none',
      zIndex: '2',
    });
    box.appendChild(tip);

    // 点击/拖动直接跳转对应时间（拖动时连续 seek，类似进度条刮擦）
    const seekFromEvent = e => {
      if (!box) return;
      let duration = 0;
      try { duration = YTEX.video.duration(); } catch {}
      if (!duration) {
        const data = getData();
        if (data && data.msg && data.msg.length) duration = Math.max(1, data.duration || data.msg.length * (data.bucketSec || 10));
      }
      if (!duration) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
      try { YTEX.video.seekTo(ratio * duration); } catch {}
    };
    canvas.addEventListener('mousedown', e => {
      scrubbing = true;
      seekFromEvent(e);
      e.preventDefault();
    });
    window.addEventListener('mouseup', () => { scrubbing = false; });

    // 悬停曲线查数（与面板图表行为一致）；拖动时同时连续跳转
    canvas.addEventListener('mousemove', e => {
      if (!box) return;
      const rect = canvas.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const ratio = Math.min(1, Math.max(0, relX / Math.max(1, rect.width)));
      const data = getData();
      const hasCurve = !!(data && data.msg && data.msg.length);
      const n = hasCurve ? data.msg.length : 0;
      const duration = currentDuration();   // 与圆点绘制同一基准（首次打开元数据未就绪也能命中）
      if (hasCurve) {
        hoverIdx = Math.min(n - 1, Math.floor(ratio * n));
      } else {
        hoverIdx = -1;
      }
      // 时间戳圆点就近命中（命中时提示改为该时间戳的文字说明；开关关闭时不命中）
      const rows = !tsDots || !YTEX.panel || !YTEX.panel.getTimestampRows ? [] : YTEX.panel.getTimestampRows();
      pointHover = null;
      let ptDist = Infinity;
      for (const r of rows) {
        const px = (Math.min(Math.max(0, r.time), duration) / duration) * rect.width;
        const d = Math.abs(relX - px);
        if (d < ptDist) { ptDist = d; pointHover = r; }
      }
      if (ptDist > 7) pointHover = null;
      // 有曲线时按桶取时间；无曲线（如仅圆点模式）按悬停比例换算播放器时长
      const sec = hasCurve
        ? Math.round(hoverIdx * (duration / Math.max(1, n)))
        : Math.round(ratio * duration);
      const laughs = (data && data.laugh || [])[hoverIdx] || 0;
      const scrubTag = scrubbing ? '　' + I('跳转中…') : '';
      if (pointHover) {
        // 圆点悬停：条数（上，仅曲线开关开启时）+ 时间戳说明（下，保留原始换行）
        let text = String(pointHover.text || '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
        if (text.length > 60) text = text.slice(0, 58) + '…';
        tip.textContent = '';
        if (enabled && hasCurve && data.msg[hoverIdx] !== undefined) {
          const counts = document.createElement('div');
          counts.textContent = `${I('留言 {0} 条', data.msg[hoverIdx])} · ${I('发笑 {0} 条', laughs)}${scrubTag}`;
          tip.appendChild(counts);
        }
        const desc = document.createElement('div');
        desc.textContent = `${fmtT(pointHover.time)}　${text}`;
        tip.appendChild(desc);
      } else if (enabled && hasCurve) {
        tip.textContent = `${fmtT(sec)}　${I('留言 {0} 条', data.msg[hoverIdx])} · ${I('发笑 {0} 条', laughs)}${scrubTag}`;
      } else {
        // 曲线开关关闭（仅圆点模式）或无曲线数据：只显示悬停处的时间
        tip.textContent = `${fmtT(sec)}${scrubTag}`;
      }
      tip.style.display = 'block';
      // 提示框跟随鼠标（左右钳制在面板内）
      const x = e.clientX - box.getBoundingClientRect().left;
      const tw = tip.offsetWidth || 160;
      tip.style.left = `${Math.max(6, Math.min(x - tw / 2, box.clientWidth - tw - 6))}px`;
      if (scrubbing) seekFromEvent(e);
      draw();
    });
    canvas.addEventListener('mouseleave', () => {
      hoverIdx = -1;
      pointHover = null;
      if (tip) tip.style.display = 'none';
      draw();
    });

    player.appendChild(box);
    applyStyle();
    return box;
  }

  function draw() {
    if (!canvas || !box.isConnected || box.style.display === 'none') return;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const data = getData();
    const hasCurve = !!(data && data.msg && data.msg.length);
    // 时长：与悬停命中共用 currentDuration（曲线数据优先，播放器不可用时退回最大时刻）
    const duration = currentDuration();
    const msg = hasCurve ? data.msg : [];
    const laugh = hasCurve ? (data.laugh || []) : [];
    // 与面板图例联动：只画当前显示的折线（面板里点图例隐藏的那条这里也不画）
    const vis = YTEX.chart && YTEX.chart.getLineVisibility ? YTEX.chart.getLineVisibility() : { laugh: true, msg: true };
    let max = 1;
    if (vis.msg) for (const v of msg) if (v > max) max = v;
    if (vis.laugh) for (const v of laugh) if (v > max) max = v;
    const secPerPt = duration / Math.max(1, msg.length);
    const plotH = h - 20;
    const baseY = h - 8;
    const X = i2 => (i2 * secPerPt / duration) * w;
    const Y = v => baseY - (v / max) * plotH;

    // 基线
    ctx.strokeStyle = 'rgba(255, 255, 255, .18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(w, baseY);
    ctx.stroke();
    // 悬停位置高亮线
    if (hasCurve && hoverIdx >= 0 && hoverIdx < msg.length) {
      ctx.strokeStyle = 'rgba(255, 255, 255, .35)';
      ctx.beginPath();
      ctx.moveTo(X(hoverIdx), 4);
      ctx.lineTo(X(hoverIdx), baseY);
      ctx.stroke();
    }
    // 折线（蓝=留言、粉=笑点，显隐与面板图例同步）
    const line = (arr, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let k = 0; k < arr.length; k++) {
        const x = X(k);
        const y = Y(arr[k]);
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      // 末桶补一段到右缘：点画在桶起点，不补则粒度越大尾部缺失越明显
      if (arr.length) ctx.lineTo(w, Y(arr[arr.length - 1]));
      ctx.stroke();
    };
    // 仅圆点模式（总开关关闭但圆点开关开启）：画基线与时间戳圆点
    // （不画当前位置虚线与悬停指示线——原生进度条自带，叠加后再画会错位出现重影）
    if (dotsOnly) {
      drawTsDots(ctx, w, h, duration, baseY);
      return;
    }
    if (hasCurve) {
      if (vis.msg) line(msg, '#6fb1ff', 1.2);
      if (vis.laugh) line(laugh, '#ff7aa2', 1.8);
    }
    // 时间戳圆点：独立于曲线/图例，只要开关开启就绘制
    drawTsDots(ctx, w, h, duration, baseY);
    // 悬停点的强调圆点（仅曲线模式）
    if (hasCurve && hoverIdx >= 0 && hoverIdx < msg.length) {
      if (vis.msg) {
        ctx.fillStyle = '#6fb1ff';
        ctx.beginPath();
        ctx.arc(X(hoverIdx), Y(msg[hoverIdx]), 3, 0, Math.PI * 2);
        ctx.fill();
      }
      if (vis.laugh && laugh[hoverIdx]) {
        ctx.fillStyle = '#ff7aa2';
        ctx.beginPath();
        ctx.arc(X(hoverIdx), Y(laugh[hoverIdx]), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    drawPositionLine(ctx, w, baseY, duration);
  }

  // 当前播放位置（白色虚线）
  function drawPositionLine(ctx, w, baseY, duration) {
    try {
      const cur = YTEX.video.currentTime();
      const x = (Math.min(Math.max(0, cur), duration) / duration) * w;
      ctx.strokeStyle = 'rgba(255, 255, 255, .8)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, baseY);
      ctx.stroke();
      ctx.setLineDash([]);
    } catch {}
  }

  // ---------- 圆点映射时长（绘制与悬停命中必须同一基准） ----------
  // 有曲线用聊天数据时长（圆点就画在该基准上）；否则播放器时长；播放器时长不可用
  // （0 / NaN / 直播 Infinity——元数据未就绪时首次打开即此状态）时退回时间戳里的最大时刻。
  // 旧实现绘制与命中各算各的：首次打开时命中坐标全错 → 悬浮圆点无说明，刷新后才恢复
  function currentDuration() {
    const data = getData();
    if (data && data.msg && data.msg.length) {
      return Math.max(1, data.duration || data.msg.length * (data.bucketSec || 10));
    }
    const rows = YTEX.panel && YTEX.panel.getTimestampRows ? YTEX.panel.getTimestampRows() : [];
    let d = 0;
    try { const vd = YTEX.video.duration(); if (vd > 0 && isFinite(vd)) d = vd; } catch {}
    if (!d) for (const r of rows) if (r.time > d) d = r.time;
    return d || 1;
  }

  // ---------- 圆点密度抽稀（时间戳密集时可调，点赞高者优先显示） ----------

  // 点赞数文本（"1.2万"/"3千"/"1.2K"/"897"）→ 数值；结果缓存在行对象上（rows 是 panel 的数组）
  function likeNum(r) {
    if (r._likeNum != null) return r._likeNum;
    const s = String(r.likes == null ? '' : r.likes).replace(/,/g, '').trim();
    let v = 0;
    const m = s.match(/([\d.]+)\s*(万|千|w|k|m|b)?/i);
    if (m) {
      v = parseFloat(m[1]) || 0;
      const u = (m[2] || '').toLowerCase();
      if (u === '万' || u === 'w') v *= 1e4;
      else if (u === '千' || u === 'k') v *= 1e3;
      else if (u === 'm') v *= 1e6;
      else if (u === 'b') v *= 1e9;
    }
    r._likeNum = v;
    return v;
  }

  // 按最小间距抽稀：时间序贪心——与上一保留圆点间距 < dotMinGap 时，点赞高者留下（平手保留更早的）
  function visibleRows(rows, w, duration) {
    const ok = [];
    for (const r of rows) if (r.time >= 0 && r.time <= duration) ok.push(r);
    if (!dotMinGap || ok.length < 2) return ok;
    const out = [];
    for (const r of ok) {
      const last = out[out.length - 1];
      if (!last || ((r.time - last.time) / duration) * w >= dotMinGap) { out.push(r); continue; }
      if (likeNum(r) > likeNum(last)) out[out.length - 1] = r;
    }
    return out;
  }

  // 时间戳圆点：独立绘制分支（只受面板「显示时间戳圆点」开关控制，
  // 与总开关/折线图例显隐完全解耦——即使折线全隐也可单独显示圆点）
  function drawTsDots(ctx, w, h, duration, baseY) {
    if (!tsDots) return;
    const rows = YTEX.panel && YTEX.panel.getTimestampRows ? YTEX.panel.getTimestampRows() : [];
    for (const r of visibleRows(rows, w, duration)) {
      if (r.time < 0 || r.time > duration) continue;
      const x = (r.time / duration) * w;
      const hot = pointHover === r;
      ctx.beginPath();
      ctx.arc(x, baseY, hot ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = hot ? '#ffd75e' : 'rgba(255, 215, 94, .92)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, .65)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function show(player) {
    ensureBox(player);
    box.style.display = 'block';
    ensureHeatStyle();
    syncHeatMarker();
    draw();
  }

  function hide() {
    if (!box) return;
    box.style.display = 'none';
    hoverIdx = -1;
    pointHover = null;
    syncHeatMarker();
    hideDotsHint();
    if (tip) tip.style.display = 'none';
  }

  const overBar = t => !!(t && t.closest && t.closest('.ytp-progress-bar, .ytp-progress-bar-container'));
  const overBox = t => !!(box && box.style.display !== 'none' && (t === box || (t && box.contains(t))));

  // ---------- 仅圆点模式：圆点说明浮层（独立 fixed 浮层，统一间距，锚定进度条） ----------
  // 实测（2026-11 新版 UI）：可见「时间胶囊」是 .ytp-tooltip-progress-bar-pill，相对宿主
  // top:45px 悬挂在宿主框下方；无预览时宿主塌缩为数像素、胶囊原生浮点离进度条很远——
  // 原生悬浮位不能当基准。统一间距链（自下而上）：进度条 →GAP→ 说明 →GAP→ 时间胶囊
  // →GAP(原生实测 10px)→ 预览图。用 translate 移动原生栈（不覆盖 YouTube 的 top/left 定位）。

  let dotsHintFx = null;     // 说明浮层（fixed，每次 mousemove 重测重摆）
  let fxShiftEl = null;      // 被我们 translate 的原生提示卡宿主
  const HINT_GAP = 10;       // 统一分隔间距

  function hideDotsHint() {
    if (fxShiftEl) { fxShiftEl.style.translate = ''; fxShiftEl = null; }   // 原生栈回落原位
    if (dotsHintFx) dotsHintFx.style.display = 'none';
  }

  function ensureDotsHintFx() {
    if (dotsHintFx) return dotsHintFx;
    dotsHintFx = document.createElement('div');
    dotsHintFx.style.cssText = 'position:fixed;display:none;pointer-events:none;' +
      'background:rgba(20,20,20,.92);color:#fff;font-size:12px;line-height:1.5;' +
      'padding:4px 10px;border-radius:6px;white-space:pre-line;max-width:280px;' +
      'overflow-wrap:anywhere;z-index:2200;text-align:center;transform:translateX(-50%);';
    document.body.appendChild(dotsHintFx);
    return dotsHintFx;
  }

  // 鼠标在进度条上移动（仅圆点模式）：就近命中圆点 → 高亮该点 + 说明文字挂到原生预览卡下
  // 整个函数包异常捕获：布局异常时退化为仅隐藏提示，不影响进度条
  function updateDotsHint(e) {
    try {
      updateDotsHintInner(e);
    } catch {
      hideDotsHint();
    }
  }

  // 说明文字渲染：原始换行原样保留（white-space:pre 不自动折行）；
  // ":表情快捷名:" 段查找聊天表情目录渲染成图片，未登记的按原文本输出。
  // 查找链：scMap（键带冒号）→ emoteStats 的 label（带/不带冒号各试一次）
  let emoteUrlCache = null, emoteUrlCacheAt = 0;
  function lookupEmoteUrl(name) {
    try {
      if (YTEX.chat && YTEX.chat.emoteUrlForShortcut) {
        const u = YTEX.chat.emoteUrlForShortcut(':' + name + ':');
        if (u) return u;
      }
      const now = Date.now();
      if (!emoteUrlCache || now - emoteUrlCacheAt > 2000) {
        emoteUrlCache = new Map();
        emoteUrlCacheAt = now;
        const list = (YTEX.chat && YTEX.chat.emoteStats) ? YTEX.chat.emoteStats() : [];
        for (const st of list) {
          if (!st.url) continue;
          // 归一化：去首尾冒号/下划线 + NFKC（宽度变体）+ 小写——官方 shortcut 与
          // 评论手写形式可能差一个前导下划线
          const key = String(st.label || '').replace(/^[:_]+|[:_]+$/g, '').normalize('NFKC').toLowerCase();
          if (key) emoteUrlCache.set(key, st.url);
          if (st.id) emoteUrlCache.set(String(st.id).normalize('NFKC').toLowerCase(), st.url);
        }
      }
      const q = String(name).replace(/^[:_]+|[:_]+$/g, '').normalize('NFKC').toLowerCase();
      return emoteUrlCache.get(q) || '';
    } catch { return ''; }
  }

  function setHintContent(el, text) {
    // 全角冒号归一（触屏输入常见），否则分段正则命中不了
    let norm = String(text || '').replace(/：/g, ':');
    // 句尾 ":快捷名" 缺闭合冒号（旧缓存里收尾冒号曾被当标点清理）：
    // 能查到表情就补回闭合冒号，兼容已缓存的旧数据
    const tail = norm.match(/:([^:\s]{1,60})$/);
    if (tail && lookupEmoteUrl(tail[1])) norm += ':';
    const parts = norm.split(/(:[^:\n]{1,60}:)/g);
    el.textContent = '';
    for (const part of parts) {
      let url = '';
      if (part.length > 2 && part.charCodeAt(0) === 58 && part.charCodeAt(part.length - 1) === 58) {
        url = lookupEmoteUrl(part.slice(1, -1));
      }
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = part;
        img.style.cssText = 'height:20px;vertical-align:-5px;margin:0 1px;';
        el.appendChild(img);
      } else {
        el.appendChild(document.createTextNode(part));
      }
    }
  }

  function updateDotsHintInner(e) {
    const bar = document.querySelector('.ytp-progress-bar');
    if (!bar) { hideDotsHint(); return; }
    const rect = bar.getBoundingClientRect();
    if (!rect.width) { hideDotsHint(); return; }
    const rows = YTEX.panel && YTEX.panel.getTimestampRows ? YTEX.panel.getTimestampRows() : [];
    const dur = currentDuration();
    const hoverRows = visibleRows(rows, rect.width, dur);   // 被密度抽稀掉的圆点不可悬停
    let best = null, bd = Infinity;
    for (const r of hoverRows) {
      if (r.time < 0 || r.time > dur) continue;
      const d = Math.abs(e.clientX - (rect.left + (r.time / dur) * rect.width));
      if (d < bd) { bd = d; best = r; }
    }
    if (!best || bd > 8) {
      // 一次性诊断：有圆点（rows 非空）却未命中——首次打开无说明类 bug 的定位用
      if (rows.length && !dotsMissLogged) {
        dotsMissLogged = true;
        try { console.info('[YTEX][dots] 悬停未命中一次性诊断：rows=' + rows.length + ' dur=' + Math.round(dur) + ' bd=' + Math.round(bd) + ' minGap=' + dotMinGap + ' clientX=' + Math.round(e.clientX) + ' barLeft=' + Math.round(rect.left) + ' barW=' + Math.round(rect.width)); } catch {}
      }
      pointHover = null; hideDotsHint(); return;
    }
    pointHover = best;
    let text = String(best.text || '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
    if (text.length > 120) text = text.slice(0, 118) + '…';
    // 该时间戳条目没有说明文字：不渲染文字框（原生胶囊已显示时间），避免空黑块
    if (!text) { hideDotsHint(); return; }
    // 找原生提示卡与「可见时间胶囊」：胶囊优先 progress-bar-pill（新版悬挂式），
    // 退回经典时间文本，再退回时间正则叶子（各布局 DOM 不同，按内容+可见性匹配最稳）
    let host = null, capBox = null;
    try { host = document.querySelector('#movie_player .ytp-tooltip'); } catch {}
    if (host) {
      const candCapsule = [
        host.querySelector('.ytp-tooltip-progress-bar-pill'),
        host.querySelector('.ytp-tooltip-text'),
      ];
      for (const c of candCapsule) {
        if (!c) continue;
        const r0 = c.getBoundingClientRect();
        if (r0.height > 4 && r0.width > 4) { capBox = c; break; }
      }
      if (!capBox) {
        for (const el of host.querySelectorAll('*')) {
          if (el.children.length !== 0) continue;
          if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test((el.textContent || '').trim())) continue;
          const r0 = el.getBoundingClientRect();
          if (r0.height > 4) { capBox = el.parentElement || el; break; }
        }
      }
    }
    const fx = ensureDotsHintFx();
    setHintContent(fx, text);   // 写入说明文字：原始换行保留，:表情快捷名: 渲染成图片
    fx.style.display = 'block';
    const fxH = fx.offsetHeight || 0;
    let anchorX = e.clientX;
    let topY = rect.top - HINT_GAP - fxH;   // 找不到原生卡：说明贴进度条上方（同一间距）
    if (host && capBox) {
      host.style.translate = '';   // 先复位再测量（防止上一次的位移累积）
      const capR = capBox.getBoundingClientRect();
      // 统一间距链：说明底 = 进度条顶 - GAP；时间胶囊可视底 = 说明顶 - GAP。
      // up > 0 原生栈需上移，up < 0 需下移（无预览时原生浮点很高，需拉近进度条）
      const capTarget = rect.top - HINT_GAP - fxH - HINT_GAP;
      let up = capR.bottom - capTarget;
      try {
        const pl = document.querySelector('#movie_player');
        if (pl) up = Math.min(up, host.getBoundingClientRect().top - pl.getBoundingClientRect().top - 8);   // 预览图不越播放器顶
      } catch {}
      host.style.translate = `0 ${-Math.round(up)}px`;
      fxShiftEl = host;
      const capR2 = capBox.getBoundingClientRect();   // 移动后的实际位置
      anchorX = capR2.left + capR2.width / 2;         // 说明居中于时间胶囊正下方
      topY = capR2.bottom + HINT_GAP;
    }
    // 实际宽度居中 + 边缘钳制（半宽随内容，最长 280px）
    const halfW = (fx.offsetWidth || 280) / 2;
    const lo = rect.left + halfW, hi = Math.max(lo, rect.right - halfW);
    fx.style.left = `${Math.round(Math.min(Math.max(anchorX, lo), hi))}px`;
    fx.style.top = `${Math.round(topY)}px`;
  }

  // 事件委托：不依赖播放器元素存活，随时可用。
  // 进入进度条或面板都保持可见；两者都离开才隐藏（预览期内不隐藏）。
  document.addEventListener('mouseover', e => {
    if (overBox(e.target)) return;                 // 已在面板内
    if ((!enabled && !tsDots) || !overBar(e.target)) return;   // 圆点开启时也可单独显示
    const player = document.querySelector('#movie_player');
    if (player) show(player);
  });
  document.addEventListener('mouseout', e => {
    if (!box || box.style.display === 'none') return;
    if (!overBar(e.target) && !overBox(e.target)) return;
    if (overBar(e.relatedTarget) || overBox(e.relatedTarget)) return;   // 仍在面板/进度条内
    if (Date.now() < previewUntil) return;                              // 预览期内保持
    hide();
  });
  // 悬停移动时随播放位置刷新指示线（面板内由 canvas 自己的 mousemove 处理）
  document.addEventListener('mousemove', e => {
    if (!box || box.style.display === 'none') return;
    if (dotsOnly) {
      // 仅圆点模式：canvas 不再接收事件（pointer-events:none），统一走文档级更新
      if (!overBar(e.target)) return;
      updateDotsHint(e);
      draw();
      return;
    }
    // 曲线模式：悬停进度条时同样更新圆点悬停说明（v1.1.68 起不再限于仅圆点模式）
    if (!overBox(e.target) && overBar(e.target)) { updateDotsHint(e); draw(); }
  }, { passive: true });
  // 触屏/触控板拖动不派发 mousemove：pointermove 补一条同样的更新路径（鼠标环境双触发无副作用）
  document.addEventListener('pointermove', e => {
    if (!box || box.style.display === 'none') return;
    if (e.pointerType === 'mouse' || !overBar(e.target)) return;
    updateDotsHint(e);
    draw();
  }, { passive: true });
  // 播放器尺寸变化时重绘
  window.addEventListener('resize', () => {
    if (box && box.style.display !== 'none') draw();
  });

  // 设置调节时的预览：只在调节（input 事件流）期间保持显示，停止调节 ~900ms 后自动收起。
  // 每次调节重排同一个定时器（无递归链）；先排收起定时器再显示——即使显示/重绘抛异常，
  // 收起也不受影响（旧实现递归链被打断后叠加层永不消失，且 previewUntil 还压制 mouseout，
  // 表现为"调完一直显示，要再进出进度条才消失"）。
  function preview(ms = 900) {
    previewUntil = Math.max(previewUntil, Date.now() + ms);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewUntil = 0;   // 先清强制保持：此后的 mouseout 走常规隐藏逻辑
      try {
        if (!box || box.style.display === 'none') return;
        // 鼠标真悬停在进度条/叠加画布上（真实悬停而非预览）→ 交给 mouseout 常规逻辑
        const hovering = (box.matches && box.matches(':hover'))
          || document.querySelector('.ytp-progress-bar-container:hover, .ytp-progress-bar:hover');
        if (!hovering) hide();
      } catch {}
    }, Math.max(200, ms));
    if (!enabled && !tsDots) return;
    try {
      const player = document.querySelector('#movie_player');
      if (player) show(player);
    } catch {}
  }

  // 读取持久化的设置
  try {
    chrome.storage.local.get(['ytexOverlayOpacity', 'ytexOverlayBgOpacity', 'ytexOverlayEnabled', 'ytexOverlayTsDots', 'ytexOverlayDotGap'], d => {
      if (d && typeof d.ytexOverlayOpacity === 'number') lineOpacity = Math.min(1, Math.max(0.1, d.ytexOverlayOpacity));
      if (d && typeof d.ytexOverlayBgOpacity === 'number') bgOpacity = Math.min(1, Math.max(0.1, d.ytexOverlayBgOpacity));
      if (d && typeof d.ytexOverlayTsDots === 'boolean') tsDots = d.ytexOverlayTsDots;
      if (d && typeof d.ytexOverlayEnabled === 'boolean') enabled = d.ytexOverlayEnabled;
      if (d && typeof d.ytexOverlayDotGap === 'number') dotMinGap = Math.min(40, Math.max(0, d.ytexOverlayDotGap));
      applyStyle();
    });
  } catch {}

  // 面板设置区实时下发
  YTEX.overlay = {
    setEnabled(v) {
      enabled = !!v;
      applyStyle();   // 总开关关闭但圆点开：仅圆点模式的透明背景
      if (!enabled && !(tsDots)) hide();
    },
    setTsDots(v) {
      tsDots = !!v;
      applyStyle();   // 圆点开：若处于仅圆点模式则去掉深色背景
      syncHeatMarker();   // 显示中即时生效：圆点开→保留原生热力图，关→恢复原生行为
    },
    setDotGap(v) {
      dotMinGap = Math.min(40, Math.max(0, Number(v) || 0));
      draw();   // 显示中即时重绘（悬停说明走同一过滤，无需另处理）
    },
    setBgOpacity(v) {
      bgOpacity = Math.min(1, Math.max(0.1, Number(v) || 0.72));
      applyStyle();
    },
    setLineOpacity(v) {
      lineOpacity = Math.min(1, Math.max(0.1, Number(v) || 0.55));
      applyStyle();
    },
    preview,
  };
})();
