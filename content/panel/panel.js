// 右侧边栏 UI（Shadow DOM 隔离）：时间戳 / 笑点曲线 / 笔记 / 总结 / 设置 五个 Tab。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};

  const MIN_W = 280;
  const I = (k, ...a) => YTEX.i18n.t(k, ...a);

  let host = null;
  let shadow = null;
  const els = {};
  let rows = [];        // { time, text, author, likes }
  const tsUnchecked = new Set();   // 未勾选导出的时间戳 key（默认全选）
  let tsSelectMode = false;        // 勾选模式：仅在选择导出时显示复选框
  let topOffset = null; // 面板垂直位置（拖动 header 调整）
  let freeMode = false;           // 自由模式：解除右侧吸附，面板可任意放置（持久化：ytexFreeMode）
  let panelOpacity = 1;           // 面板整体不透明度（持久化：ytexPanelOpacity，0.2–1）
  let panelBlur = 0;              // 面板背景模糊度 px（持久化：ytexPanelBlur，0–20）
  let panelLocked = false;        // 锁定：禁用拖动/缩放，防误触（持久化：ytexPanelLocked）
  let fabHidden = false;          // 悬浮球已移除（持久化：ytexFabHidden；设置页勾选/工具栏图标可恢复）
  let leftOffset = null;          // 自由模式下面板左边缘位置
  let freeSize = null;            // 自由模式下面板尺寸 { w, h }
  let chartData = null;
  let curNearest = null;           // 距视频当前位置最近的时间戳条目（{key,time}）
  let followPausedUntil = 0;       // 用户手动滚动列表后暂停自动跟随至该时刻
  let viewBucket = 0;              // 显示层桶宽（滚轮调整；0 = 自适应）     // { laugh[], msg[], bucketSec, duration }
  let chartHandle = null;   // YTEX.chart.render 返回的交互句柄
  const statusParts = { common: '', comments: '', chat: '' };
  const heat = { host: null, canvas: null };

  // ---------- 工具 ----------

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
  }

  // "90" / "1:30" / "1:02:03" → 秒；非法输入返回 null
  function parseTime(str) {
    str = String(str).trim();
    if (!str) return null;
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    const parts = str.split(':').map(p => p.trim());
    if (!parts.every(p => /^\d+$/.test(p)) || parts.length > 3) return null;
    return parts.reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
  }

  // ---------- 主题 ----------

  function applyTheme(t) {
    const dark = t === 'dark';
    host.classList.toggle('dark', dark);
    els.themeLight.classList.toggle('active', !dark);
    els.themeDark.classList.toggle('active', dark);
    if (chartData) {
      renderChartReal(); // 主题色变化，重绘图表取新变量
    }
  }

  function loadTheme() {
    applyTheme('light'); // 默认浅色
    try {
      chrome.storage.local.get('ytexTheme', d => {
        if (chrome.runtime.lastError) return;
        applyTheme(d && d.ytexTheme === 'dark' ? 'dark' : 'light');
      });
    } catch {}
  }

  function setTheme(t) {
    applyTheme(t);
    try { chrome.storage.local.set({ ytexTheme: t }); } catch {}
  }

  // ---------- 笔记（时间戳编辑器） ----------

  let notesVid = null;
  let notesSaveTimer = 0;
  let noteMarker = '★';           // 重点标记符号（设置 Tab 可自定义）
  let notePauseOnInsert = true;    // 插入时间戳时是否暂停视频（可开关）

  const notesKey = vid => `ytexNotes:${vid}`;

  function saveNotesNow() {
    if (!notesVid) return;
    const val = els.notesArea.value;
    try {
      chrome.storage.local.set({ [notesKey(notesVid)]: val }, () => { void chrome.runtime.lastError; });
    } catch {}
  }

  function scheduleSaveNotes() {
    if (notesSaveTimer) clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => { notesSaveTimer = 0; saveNotesNow(); }, 400);
  }

  // ---------- AI 总结 ----------

  let aiRaw = '';
  let aiVid = null;                // 当前 AI 视图对应的视频 ID（缓存读/写用）
  let subsCache = null;            // 字幕下载：{ vid, tracks, title }

  function renderAiOutput(text) {
    els.aiOut.textContent = '';
    const lines = String(text).split('\n');
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'notes-preview-row';
      let last = 0;
      let any = false;
      for (const m of line.matchAll(YTEX.tsRegex())) {
        const t = YTEX.clockToSeconds(m[0]);
        if (t === null) continue;
        any = true;
        if (m.index > last) row.appendChild(document.createTextNode(line.slice(last, m.index)));
        const chip = document.createElement('button');
        chip.className = 'notes-ts';
        chip.dataset.time = t;
        chip.textContent = m[0];
        row.appendChild(chip);
        last = m.index + m[0].length;
      }
      if (last < line.length) row.appendChild(document.createTextNode(line.slice(last)));
      if (!any && !row.childNodes.length) row.textContent = '\u00a0';
      els.aiOut.appendChild(row);
    }
  }

  function saveAiCfg() {
    try {
      chrome.storage.local.set({
        ytexAiUrl: els.aiUrl.value.trim(),
        ytexAiKey: els.aiKey.value.trim(),
        ytexAiModel: els.aiModel.value.trim(),
        ytexAiOutLang: els.aiOutLang.value,
        ytexAiType: els.aiType.value,
        ytexAiExtra: els.aiExtra.value,
        ytexAiGlossaryMax: Math.max(0, Math.round(Number(els.aiGlossMax.value) || 0)),
      });
    } catch {}
  }

  function loadAiCfg() {
    try {
      chrome.storage.local.get(['ytexAiUrl', 'ytexAiKey', 'ytexAiModel', 'ytexAiOutLang', 'ytexAiExtra', 'ytexAiType', 'ytexAiGlossaryMax'], d => {
        if (chrome.runtime.lastError || !d) return;
        els.aiUrl.value = d.ytexAiUrl || '';
        els.aiKey.value = d.ytexAiKey || '';
        els.aiModel.value = d.ytexAiModel || '';
        els.aiOutLang.value = d.ytexAiOutLang || 'auto';
        els.aiExtra.value = d.ytexAiExtra || '';
        els.aiType.value = d.ytexAiType || 'auto';
        els.aiGlossMax.value = d.ytexAiGlossaryMax > 0 ? String(d.ytexAiGlossaryMax) : '';
      });
    } catch {}
  }

  const fmtWhen = ts => new Date(ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  // 追问会话（持久化到 chrome.storage.local 的 ytexAiFollowups，与 ai.js 共用键）
  const aiFollowHist = new Map();       // vid → [{role, content}]
  const FOLLOWUP_STORE_KEY = 'ytexAiFollowups';
  let followupStoreLoaded = false;

  function persistFollowHist(vid) {
    if (!vid) return;
    try {
      chrome.storage.local.get([FOLLOWUP_STORE_KEY], d => {
        try {
          const all = (d && d[FOLLOWUP_STORE_KEY]) || {};
          const hist = aiFollowHist.get(vid);
          if (hist && hist.length) all[vid] = { history: hist, at: Date.now() };
          else delete all[vid];
          // LRU：按 at 保留最近 20 个视频（与 ai.js 上限一致）
          const entries = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 20);
          const payload = {};
          for (const [k, v] of entries) payload[k] = v;
          chrome.storage.local.set({ [FOLLOWUP_STORE_KEY]: payload }, () => { void chrome.runtime.lastError; });
        } catch {}
      });
    } catch {}
  }

  function loadFollowHist(vid) {
    return new Promise(resolve => {
      if (aiFollowHist.has(vid)) return resolve(aiFollowHist.get(vid));
      try {
        chrome.storage.local.get([FOLLOWUP_STORE_KEY], d => {
          try {
            const all = (d && d[FOLLOWUP_STORE_KEY]) || {};
            const e = all[vid];
            const hist = e && Array.isArray(e.history) ? e.history : [];
            aiFollowHist.set(vid, hist);
            resolve(hist);
          } catch { resolve([]); }
        });
      } catch { resolve([]); }
    });
  }
  let aiFollowBusy = false;

  function renderFollow() {
    const vid = aiVid;
    if (!vid) { els.aiFollowList.textContent = ''; return; }
    loadFollowHist(vid).then(hist => {
      if (aiVid !== vid) return;   // 等待期间已切走
      renderFollowHist(hist);
    });
  }

  function renderFollowHist(hist) {
    els.aiFollowList.textContent = '';
    if (!hist.length) {
      els.aiFollowList.textContent = I('总结生成后，可在此继续追问视频相关问题');
      return;
    }
    for (const m of hist) {
      const row = document.createElement('div');
      row.className = 'ai-follow-msg ' + (m.role === 'user' ? 'user' : 'assistant');
      const tag = document.createElement('span');
      tag.className = 'ai-follow-tag';
      tag.textContent = m.role === 'user' ? I('我') : I('AI');
      row.appendChild(tag);
      const body = document.createElement('span');
      body.className = 'ai-follow-body';
      // 回答里的时间戳渲染成可点击芯片
      const parts = String(m.content).split(/\b((?:\d{1,2}:)?[0-5]?\d:[0-5]\d)\b/g);
      parts.forEach((part, idx) => {
        if (!part) return;
        if (idx % 2 === 1) {
          const t = YTEX.clockToSeconds(part);
          if (t !== null) {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.dataset.time = t;
            chip.textContent = part;
            body.appendChild(chip);
            return;
          }
        }
        body.appendChild(document.createTextNode(part));
      });
      row.appendChild(body);
      els.aiFollowList.appendChild(row);
    }
    els.aiFollowList.scrollTop = els.aiFollowList.scrollHeight;
  }

  // 追问提交：调 YTEX.ai.followup，回答入会话并渲染
  async function submitFollow() {
    if (aiFollowBusy) return;
    const q = els.aiFollowInput.value.trim();
    if (!q) return;
    if (!aiVid && !aiRaw) { setStatus(I('非视频页，无法追问')); return; }
    els.aiFollowInput.value = '';
    const hist = aiFollowHist.get(aiVid) || [];
    hist.push({ role: 'user', content: q });
    aiFollowHist.set(aiVid, hist);
    aiFollowBusy = true;
    els.aiFollowBtn.disabled = true;
    const pending = document.createElement('div');
    pending.className = 'ai-follow-msg assistant';
    pending.textContent = I('AI') + '：…';
    els.aiFollowList.appendChild(pending);
    els.aiFollowList.scrollTop = els.aiFollowList.scrollHeight;
    try {
      const answer = await YTEX.ai.followup(q);
      hist.push({ role: 'assistant', content: answer || '（空）' });
    } catch (err) {
      hist.push({ role: 'assistant', content: I('追问失败：{0}', String(err.message || err).slice(0, 120)) });
    }
    aiFollowBusy = false;
    els.aiFollowBtn.disabled = false;
    persistFollowHist(aiVid);
    renderFollow();
  }

  // 切视频时恢复该视频已缓存的总结（没有则回到占位提示），并刷新字幕轨道列表
  function loadAi(vid) {
    aiVid = vid || null;
    els.aiMeta.textContent = '';
    aiRaw = '';
    aiFollowHist.delete(vid);   // 内存会话随视频切换清空（持久化历史仍在存储中）
    els.aiCopyBtn.disabled = true;
    els.aiOut.textContent = I('填写上方配置后，点击「生成总结」——将综合字幕、评论区时间戳与聊天高能生成内容总结。');
    refreshSubsTracks(vid);
    if (!aiVid) return;
    YTEX.ai.getCachedSummary(aiVid).then(e => {
      if (!e || aiVid !== vid) return;   // 等待期间已切走
      aiRaw = e.text;
      renderAiOutput(e.text);
      els.aiCopyBtn.disabled = false;
      els.aiMeta.textContent = I('已恢复缓存的总结（生成于 {0}）· 重新生成将覆盖', fmtWhen(e.at));
    });
  }

  // 字幕轨道列表：实时拉取（baseUrl 有时效），人工字幕优先默认选中，ASR 自动字幕标注「（自动）」
  async function refreshSubsTracks(vid) {
    els.subsSel.textContent = '';
    els.subsBtn.disabled = true;
    const waitOpt = document.createElement('option');
    waitOpt.value = '';
    waitOpt.textContent = vid ? I('获取字幕轨道…') : I('非视频页');
    els.subsSel.appendChild(waitOpt);
    if (!vid) return;
    try {
      const info = await YTEX.subs.listTracks(vid);
      if (aiVid !== vid) return;   // 等待期间已切走
      subsCache = { vid, tracks: info.tracks, title: info.title };
      els.subsSel.textContent = '';
      if (!info.tracks.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = I('该视频没有可用字幕');
        els.subsSel.appendChild(o);
        return;
      }
      for (const [i, tr] of info.tracks.entries()) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `${tr.name}${tr.asr ? I('（自动）') : ''}${tr.code ? ` [${tr.code}]` : ''}`;
        els.subsSel.appendChild(o);
      }
      const manual = info.tracks.findIndex(t => !t.asr);
      els.subsSel.value = String(manual >= 0 ? manual : 0);
      els.subsBtn.disabled = false;
    } catch (err) {
      if (aiVid !== vid) return;
      subsCache = null;
      els.subsSel.textContent = '';
      const o = document.createElement('option');
      o.value = '';
      o.textContent = I('获取失败（{0}）', String((err && err.message) || err).slice(0, 60));
      els.subsSel.appendChild(o);
    }
  }

  function syncPauseBtn() {
    els.notePauseBtn.textContent = notePauseOnInsert ? I('⏸ 暂停:开') : I('⏸ 暂停:关');
    els.notePauseBtn.classList.toggle('toggle-on', notePauseOnInsert);
  }

  function loadPauseOnInsert() {
    try {
      chrome.storage.local.get(['ytexNotePause'], d => {
        if (chrome.runtime.lastError || !d) return;
        notePauseOnInsert = d.ytexNotePause !== false;   // 默认开启
        syncPauseBtn();
      });
    } catch {}
  }

  // 读取面板布局设置（自由模式/透明度/模糊度/锁定），同步 UI 并应用
  function loadPanelLayout() {
    try {
      chrome.storage.local.get(['ytexFreeMode', 'ytexPanelOpacity', 'ytexPanelBlur', 'ytexPanelLocked', 'ytexFreePos', 'ytexFreeSize'], d => {
        if (chrome.runtime.lastError || !d) return;
        freeMode = d.ytexFreeMode === true;
        panelOpacity = typeof d.ytexPanelOpacity === 'number' ? d.ytexPanelOpacity : 1;
        panelBlur = typeof d.ytexPanelBlur === 'number' ? d.ytexPanelBlur : 0;
        panelLocked = d.ytexPanelLocked === true;
        if (els.panelOpacityRange) els.panelOpacityRange.value = String(panelOpacity);
        if (els.panelBlurRange) els.panelBlurRange.value = String(panelBlur);
        if (typeof applyPanelOpacity === 'function') applyPanelOpacity();
        if (typeof applyPanelBlur === 'function') applyPanelBlur();
        if (d.ytexFreePos && typeof d.ytexFreePos.left === 'number') leftOffset = d.ytexFreePos.left;
        if (d.ytexFreePos && typeof d.ytexFreePos.top === 'number') topOffset = d.ytexFreePos.top;
        else if (typeof d.ytexTopOffset === 'number') topOffset = d.ytexTopOffset;
        if (typeof d.ytexDockedH === 'number' && d.ytexDockedH >= 300) els.panel.style.height = `${d.ytexDockedH}px`;
        if (d.ytexFreeSize && typeof d.ytexFreeSize.w === 'number') freeSize = d.ytexFreeSize;
        if (els.freeModeToggle) els.freeModeToggle.checked = freeMode;
        if (els.panelLockedToggle) els.panelLockedToggle.checked = panelLocked;
        if (els.panelOpacityRange) els.panelOpacityRange.value = String(panelOpacity);
        if (els.panelBlurRange) els.panelBlurRange.value = String(panelBlur);
        applyFreeMode();
        applyPanelLook();
        if (YTEX.overlay) YTEX.overlay.setTsDots(els.overlayTsDots.checked);
      });
    } catch {}
  }

  // 读取时间轴叠加设置（开关/背景/折线透明度），同步 UI 并下发给叠加层
  function loadOverlaySettings() {
    try {
      chrome.storage.local.get(['ytexOverlayEnabled', 'ytexOverlayOpacity', 'ytexOverlayBgOpacity'], d => {
        if (chrome.runtime.lastError || !d) return;
        const on = d.ytexOverlayEnabled !== false;   // 默认开启
        els.overlayToggle.checked = on;
        els.overlayBg.value = String(typeof d.ytexOverlayBgOpacity === 'number' ? d.ytexOverlayBgOpacity : 0.72);
        els.overlayLine.value = String(typeof d.ytexOverlayOpacity === 'number' ? d.ytexOverlayOpacity : 0.55);
        els.overlayTsDots.checked = d.ytexOverlayTsDots !== false;   // 默认开
        if (YTEX.overlay) {
          YTEX.overlay.setEnabled(on);
          YTEX.overlay.setBgOpacity(Number(els.overlayBg.value));
          YTEX.overlay.setLineOpacity(Number(els.overlayLine.value));
          YTEX.overlay.setTsDots(els.overlayTsDots.checked);
        }
      });
    } catch {}
  }

  function loadNotes(vid) {
    saveNotesNow();               // 先保存上一个视频尚未落盘的编辑
    notesVid = vid || null;
    els.notesArea.value = '';
    if (!notesVid) return;
    try {
      chrome.storage.local.get([notesKey(notesVid)], d => {
        if (chrome.runtime.lastError) return;
        if (notesVid === vid) {
          els.notesArea.value = (d && d[notesKey(vid)]) || '';
          renderNotesPreview();
        }
      });
    } catch {}
  }

  function insertIntoNotes(text, cursorOffset = null) {
    const ta = els.notesArea;
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? s;
    const before = ta.value.slice(0, s);
    // 光标处于未闭合的【内（如在小节标题里补时间戳）→ 行内插入，不强制换行
    const lineStart = before.lastIndexOf('\n') + 1;
    const curLine = before.slice(lineStart);
    const inBracket = curLine.includes('【') && !curLine.includes('】');
    const nl = !inBracket && before && !before.endsWith('\n') ? '\n' : '';
    ta.value = before + nl + text + ta.value.slice(e);
    const pos = s + nl.length + (cursorOffset === null ? text.length : cursorOffset);
    ta.setSelectionRange(pos, pos);
    ta.focus();
    scheduleSaveNotes();
    renderNotesPreview();
  }

  // 笔记预览：逐行渲染，时间戳文本变为可点击跳转按钮；
  // 每行首个时间戳附 -1s/+1s 微调按钮（直接改写编辑框内文本并跳转）
  function renderNotesPreview() {
    if (!els.notesPreview) return;
    const box = els.notesPreview;
    box.textContent = '';
    const lines = els.notesArea.value.split('\n');
    lines.forEach((line, idx) => {
      const row = document.createElement('div');
      row.className = 'notes-preview-row';
      if (!line.trim()) { row.textContent = '\u00a0'; box.appendChild(row); return; }
      let last = 0, hasChip = false;
      for (const m of line.matchAll(YTEX.tsRegex())) {
        const t = YTEX.clockToSeconds(m[0]);
        if (t === null) continue;
        if (m.index > last) row.appendChild(document.createTextNode(line.slice(last, m.index)));
        const chip = document.createElement('button');
        chip.className = 'notes-ts';
        chip.dataset.time = t;
        chip.textContent = m[0];
        row.appendChild(chip);
        hasChip = true;
        last = m.index + m[0].length;
      }
      if (last < line.length) row.appendChild(document.createTextNode(line.slice(last)));
      if (!hasChip) row.appendChild(document.createTextNode(line));
      if (hasChip) {
        const minus = document.createElement('button');
        minus.className = 'notes-adj';
        minus.dataset.line = idx;
        minus.dataset.delta = -1;
        minus.textContent = '-1s';
        minus.title = I('该行第一个时间戳 -1 秒并跳转');
        const plus = document.createElement('button');
        plus.className = 'notes-adj';
        plus.dataset.line = idx;
        plus.dataset.delta = 1;
        plus.textContent = '+1s';
        plus.title = I('该行第一个时间戳 +1 秒并跳转');
        row.append(minus, plus);
      }
      box.appendChild(row);
    });
  }

  // 调整指定行的第一个时间戳 ±delta 秒：改写文本 → 重新渲染 → 跳转到新时间
  function adjustLineTs(lineIdx, delta) {
    const lines = els.notesArea.value.split('\n');
    const line = lines[lineIdx] || '';
    const m = YTEX.tsRegex().exec(line);
    if (!m) return;
    const cur = YTEX.clockToSeconds(m[0]);
    if (cur === null) return;
    const nv = Math.max(0, cur + delta);
    lines[lineIdx] = line.slice(0, m.index) + fmt(nv) + line.slice(m.index + m[0].length);
    els.notesArea.value = lines.join('\n');
    scheduleSaveNotes();
    renderNotesPreview();
    YTEX.video.seekTo(nv);
    setStatus(I('笔记时间戳已调整为 {0} 并跳转', fmt(nv)));
  }

  // 选中行（无选中时为当前行）整体增/减一级缩进（全角空格）
  function indentSelection(dent) {
    const ta = els.notesArea;
    const v = ta.value;
    const s = ta.selectionStart ?? 0;
    const e = ta.selectionEnd ?? 0;
    const lineStart = v.lastIndexOf('\n', Math.max(0, s - 1)) + 1;
    let lineEnd = v.indexOf('\n', e);
    if (lineEnd === -1) lineEnd = v.length;
    const lines = v.slice(lineStart, lineEnd).split('\n');
    const out = lines.map(l => (dent ? '　' + l : l.replace(/^[　\t ]/, ''))).join('\n');
    ta.value = v.slice(0, lineStart) + out + v.slice(lineEnd);
    ta.setSelectionRange(lineStart, lineStart + out.length);
    ta.focus();
    scheduleSaveNotes();
  }

  // 选中行（无选中时为当前行）切换重点标记：有未标记行 → 全部标记；全部已标记 → 全部取消
  function toggleMarkerSelection() {
    const ta = els.notesArea;
    const v = ta.value;
    const s = ta.selectionStart ?? 0;
    const e = ta.selectionEnd ?? 0;
    const lineStart = v.lastIndexOf('\n', Math.max(0, s - 1)) + 1;
    let lineEnd = v.indexOf('\n', e);
    if (lineEnd === -1) lineEnd = v.length;
    const lines = v.slice(lineStart, lineEnd).split('\n');
    const leadOf = l => (l.match(/^[　\s]*/) || [''])[0];
    const restOf = l => l.slice(leadOf(l).length);
    const mark = !lines.every(l => restOf(l).startsWith(noteMarker));
    const out = lines.map(l => {
      const lead = leadOf(l);
      const rest = restOf(l);
      if (!rest) return l;                       // 空行不动
      if (mark) return lead + noteMarker + ' ' + rest;
      return rest.startsWith(noteMarker) ? lead + rest.slice(noteMarker.length).replace(/^[　\s]/, '') : l;
    }).join('\n');
    ta.value = v.slice(0, lineStart) + out + v.slice(lineEnd);
    ta.setSelectionRange(lineStart, lineStart + out.length);
    ta.focus();
    scheduleSaveNotes();
  }

  function syncMarkerUI() {
    if (els.noteMarkBtn) els.noteMarkBtn.textContent = `${noteMarker} ${I('重点')}`;
    if (els.markerInput) els.markerInput.value = noteMarker;
  }

  // 面板横向宽度自适应：头部 Tab 文本放不下时自动加宽（只拉伸不收缩，用户仍可手动调窄）
  function fitPanelWidthToTabs() {
    if (!els.panel || !els.header) return;
    const need = els.header.scrollWidth;   // 头部（logo + 全部 Tab + 收起钮）完整显示所需宽度
    const cur = els.panel.getBoundingClientRect().width;
    if (need > cur + 1) {
      els.panel.style.width = `${need}px`;
      requestAnimationFrame(resetInputScroll);
    }
  }

  // 加宽后归零输入框残留的横向滚动：变窄期间输入的值会把 scrollLeft 顶到最大，
  // 面板变宽后浏览器不会自动复位，文字就一直"陷"在左侧被裁（与框不对齐的观感）
  function resetInputScroll() {
    if (!els.panel) return;
    els.panel.querySelectorAll('input').forEach(inp => {
      try { if (inp.scrollWidth <= inp.clientWidth + 1) inp.scrollLeft = 0; } catch {}
    });
  }

  // 语言切换 / 初始应用：重设面板全部静态文案并刷新动态区域
  function applyTexts() {
    const T = k => YTEX.i18n.t(k);
    const labels = [T('时间戳'), T('笑点曲线'), T('笔记'), T('总结'), T('设置')];
    [...els.tabs.children].forEach((tab, i) => { tab.textContent = labels[i]; });
    fitPanelWidthToTabs();   // 日语等长标签放不下时自动加宽面板
    els.fab.title = T('高光时刻');
    els.min.title = T('收起 (Esc)');
    els.resize.title = T('拖拽调宽');
    els.tsSelectBtn.textContent = tsSelectMode ? T('⏹ 退出选择') : T('☑ 选择导出');
    els.tsMaster.title = T('全选 / 全不选');
    els.tsCopyBtn.textContent = T('复制所选');
    els.tsCopyBtn.title = T('按时间顺序复制勾选的时间戳及说明');
    els.noteTsBtn.textContent = T('⏱ 插入时间戳');
    els.noteTsBtn.title = T('暂停视频并把当前时间戳插入光标处');
    syncPauseBtn();
    els.noteSecBtn.textContent = T('【节】');
    els.noteSecBtn.title = T('插入大节标题，光标落在【】内');
    els.noteSubBtn.textContent = T('└ 小节');
    els.noteSubBtn.title = T('插入带缩进的小节行');
    syncMarkerUI();
    els.noteMarkBtn.title = T('给选中（或当前）行切换重点标记（符号可在设置自定义）');
    els.noteIndentBtn.textContent = T('⇥ 缩进');
    els.noteIndentBtn.title = T('给选中（或当前）行增加一级缩进');
    els.noteOutdentBtn.textContent = T('⇤ 减缩进');
    els.noteOutdentBtn.title = T('给选中（或当前）行减少一级缩进');
    els.noteCopyBtn.textContent = T('复制');
    els.noteCopyBtn.title = T('复制全部内容到剪贴板');
    els.notesArea.placeholder = T('点「⏱ 插入时间戳」记录当前位置，再加文字说明；内容按视频自动保存。');
    els.notesHint.textContent = T('时间戳可点击跳转验证；行内 -1s/+1s 可微调时间；内容按视频自动保存。');
    els.hTheme.textContent = T('主题');
    els.themeLight.textContent = T('浅色');
    els.themeDark.textContent = T('深色');
    els.hLang.textContent = T('语言');
    [...els.langSel.options].forEach(o => { o.textContent = T(o.dataset.i18n); });
    els.hMarker.textContent = T('笔记重点标记');
    if (els.markerHint) els.markerHint.textContent = T('输入自定义符号（如 ★ / 🔥 / ❗），用于笔记工具栏');
    els.hKw.textContent = T('发笑关键词（每行一个，与内置规则叠加）');
    els.kwArea.placeholder = T('例如：\n笑嘻了\n乐\n666');
    els.kwSaveBtn.textContent = T('保存关键词');
    els.kwClearBtn.textContent = T('清除表情标记');
    els.hAI.textContent = T('AI 设置');
    if (els.aiNote) els.aiNote.textContent = T('选择服务商可自动填入地址与模型示例；Key 在服务商控制台获取，仅保存在本地。支持 OpenAI 兼容协议的任意平台（含 Ollama/LM Studio 本地模型）。');
    const aiLabels = [T('服务商'), T('API 地址'), T('API Key'), T('模型'), T('输出语言'), T('直播类型'), T('术语数量上限'), T('自定义要求')];
    [...els.secAI.querySelectorAll('.ai-label')].forEach((l, i) => { if (aiLabels[i]) l.textContent = aiLabels[i]; });
    els.aiGenBtn.textContent = T('生成总结');
    els.aiCopyBtn.textContent = T('复制');
    els.aiCacheBtn.textContent = T('清除缓存');
    if (els.aiType) [...els.aiType.options].forEach(o => { o.textContent = T(o.dataset.i18n); });
    els.hSubs.textContent = T('字幕下载');
    if (els.aiDisclaimer) els.aiDisclaimer.textContent = T('内容由 AI 生成，可能有误，仅供参考');
    if (els.aiGlossMax) {
      els.aiGlossMax.placeholder = T('不限；填数字限制术语条数（如 10）');
      els.aiGlossMax.title = T('网络用语/专业术语最多列出的条数；留空或 0 表示不限制');
    }
    if (els.aiFollowBtn) els.aiFollowBtn.textContent = T('追问');
    if (els.aiFollowInput) els.aiFollowInput.placeholder = T('基于总结追问，如：哪个时间段最精彩？');
    if (els.aiFollowList && !(aiFollowHist.get(aiVid) || []).length) {
      els.aiFollowList.textContent = T('总结生成后，可在此继续追问视频相关问题');
    }
    els.subsBtn.textContent = T('下载 SRT');
    // 工具条按钮（时间戳 Tab 顶部）
    els.tsTopBtn.textContent = T('⬆ 顶部');
    els.tsTopBtn.title = T('回到列表顶部');
    els.tsCurBtn.textContent = T('⌖ 当前位置');
    els.tsCurBtn.title = T('滚动到距播放位置最近的时间戳，并恢复自动跟随');
    // 笑点曲线 Tab：时间轴叠加设置 + 聊天缓存按钮 + 表情标记列表
    if (els.overlayToggleLabel) els.overlayToggleLabel.textContent = T('在视频进度条上方显示笑点曲线');
    if (els.overlayTsLabel) els.overlayTsLabel.textContent = T('显示时间戳圆点');
    if (els.overlayBgLabel) els.overlayBgLabel.textContent = T('背景透明度');
    if (els.overlayLineLabel) els.overlayLineLabel.textContent = T('折线透明度');
    if (els.cacheBtn) els.cacheBtn.textContent = T('清除本视频聊天缓存');
    renderEmotes();
    // 总结 Tab：封面下载 / 服务商预设全部选项 / 输出占位文案
    els.thumbBtn.textContent = T('下载封面');
    if (els.aiPresetKeys) [...els.aiPreset.options].forEach((o, i) => {
      if (els.aiPresetKeys[i]) o.textContent = T(els.aiPresetKeys[i][1]);
    });
    if (!aiRaw && !YTEX.ai.isGenerating()) {
      els.aiOut.textContent = T('填写上方配置后，点击「生成总结」——将综合字幕、评论区时间戳与聊天高能生成内容总结。');
    }
    // 设置 Tab：面板区块
    els.hPanel.textContent = T('面板');
    if (els.freeModeLabel) els.freeModeLabel.textContent = T('自由模式（面板可任意放置）');
    if (els.freeModeLabel) els.freeModeLabel.title = T('解除右侧吸附：面板可拖动到画面任意位置，宽高自由调整');
    if (els.panelLockLabel) els.panelLockLabel.textContent = T('锁定面板位置（防止误触拖动）');
    if (els.panelOpacityLabel) els.panelOpacityLabel.textContent = T('面板透明度');
    if (els.panelBlurLabel) els.panelBlurLabel.textContent = T('背景模糊度');
    els.panelResetBtn.textContent = T('重置面板位置和大小');
    // 状态栏：评论/聊天两段按各自当前状态重译
    try { YTEX.comments.refreshStatus?.(); } catch {}
    try { YTEX.chat.refreshStatus?.(); } catch {}
    els.langSel.value = YTEX.i18n.lang;
    renderRows();
    renderChartReal();
    renderNotesPreview();
    refreshSettings();
  }

  function loadMarker() {
    try {
      chrome.storage.local.get(['ytexNoteMarker'], d => {
        if (chrome.runtime.lastError || !d || !d.ytexNoteMarker) return;
        noteMarker = d.ytexNoteMarker;
        syncMarkerUI();
      });
    } catch {}
  }

  // ---------- 渲染 ----------

  const expandedRows = new Set();      // 已展开"完整评论"详情的行（按行 key，同评论的其他行不受影响）
  // 详情框定位请求：展开后框内滚到目标时间戳行。评论流式到达会频繁重建 DOM（框内滚动位置
  // 随之丢失），因此 8s 内每次重渲染都重新定位；用户框内滚动或收起后停止。
  let detailFocusReq = null;           // { key, time, until }

  // 展开的详情框：框内滚到目标时间戳行并高亮（重渲染后重挂载会丢失滚动位置，这里恢复）。
  // buildDetail 已给"该行自己的时间戳"标了 .chip.active，优先用它；否则按时间就近匹配。
  function applyDetailFocus() {
    if (!detailFocusReq) return;
    const { key, time, until } = detailFocusReq;
    if (!expandedRows.has(key) || Date.now() > until) { detailFocusReq = null; return; }
    requestAnimationFrame(() => {
      if (!detailFocusReq || detailFocusReq.key !== key) return;
      const row = els.tsList.querySelector(`.row[data-key="${CSS.escape(key)}"]`);
      const detail = row && row.nextElementSibling;
      if (!detail || !detail.classList.contains('detail')) {
        return;
      }
      // 面板滚动：让详情框完整露出（框限高 260px，通常一屏内可放下）
      const br = detail.getBoundingClientRect();
      const sr = els.body.getBoundingClientRect();
      if (br.bottom > sr.bottom) els.body.scrollTop += br.bottom - sr.bottom + 8;
      if (br.top < sr.top) els.body.scrollTop -= sr.top - br.top + 8;
      // 框内滚动：定位到该行自己的时间戳。
      // 实测教训：限高样式若没实际生效（scrollHeight === clientHeight），scrollTop 赋值
      // 无处可滚——所以在滚动当下把样式强制写到目标元素上，并校验可滚动性。
      detail.style.maxHeight = '260px';
      detail.style.overflowY = 'auto';
      let chip = detail.querySelector('.chip.active');
      if (!chip) {
        let bestDiff = Infinity;
        for (const c of detail.querySelectorAll('.chip[data-time]')) {
          const d = Math.abs(Number(c.dataset.time) - time);
          if (d < bestDiff) { bestDiff = d; chip = c; }
        }
        if (chip && bestDiff > 2) chip = null;
      }
      if (!chip) return;
      // 交给浏览器原生定位：无论框内布局如何（实测存在滚动高度异常的布局形态），
      // scrollIntoView 都会沿正确的滚动容器把芯片居中
      chip.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  }

  // 文本里的 ":表情快捷名:" 渲染成表情图片（聊天目录登记过的快捷名）；
  // 未登记的按原文本输出
  function appendTextWithEmotes(parent, text) {
    // 快捷名可含日文等非 ASCII 字符（如 ":_LOVEラブ:"），不能只按 ASCII 匹配
    for (const part of String(text).split(/(:[^:\s]{1,60}:)/g)) {
      if (!part) continue;
      const url = part.startsWith(':') && part.endsWith(':') && YTEX.chat.emoteUrlForShortcut
        ? YTEX.chat.emoteUrlForShortcut(part) : '';
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'emote-img';
        img.alt = part;
        parent.appendChild(img);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
  }

  // 详情块：完整评论文本，文中出现的时间戳文本就地替换为可点击跳转的按钮
  function buildDetail(r) {
    const box = document.createElement('div');
    box.className = 'detail';
    // 限高 + 框内滚动（内联样式确保生效）：长评论不撑开面板，展开时框内滚到对应时间戳行
    Object.assign(box.style, {
      maxHeight: '260px',
      overflowY: 'auto',
      overscrollBehavior: 'contain',
    });

    const txt = document.createElement('div');
    txt.className = 'detail-text';
    const text = r.fullText || r.text;
    let last = 0;
    for (const m of text.matchAll(YTEX.tsRegex())) {
      const t = YTEX.clockToSeconds(m[0]);
      if (t === null) continue;
      if (m.index > last) appendTextWithEmotes(txt, text.slice(last, m.index));
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.dataset.time = t;
      chip.textContent = m[0];
      if (t === r.time) chip.classList.add('active'); // 高亮点击「全文」的那一行自己的时间戳
      txt.appendChild(chip);
      last = m.index + m[0].length;
    }
    if (last < text.length) appendTextWithEmotes(txt, text.slice(last));

    box.append(txt);
    return box;
  }


  function updateChartScroll(v) {
    if (!els.chartScroll || !els.chartScrollThumb) return;
    if (!v) {
      if (chartHandle) v = chartHandle.view();
      else return;
    }
    const full = v.duration || 1;
    const ratio = Math.min(1, (v.end - v.start) / full);
    // 全片视图时隐藏滚动条
    els.chartScroll.style.display = ratio >= 0.999 ? 'none' : 'block';
    const thumbW = Math.max(10, ratio * 100);
    els.chartScrollThumb.style.width = `${thumbW}%`;
    els.chartScrollThumb.style.left = `${(v.start / full) * 100}%`;
  }

  function renderChartReal() {
    if (!chartData) {
      chartHandle = null;
      YTEX.chart.clear(els.chartCanvas);
      els.chartNote.textContent = I('尚无聊天数据——见底部状态栏说明');
      return;
    }
    els.chartNote.textContent = I('Ctrl+滚轮缩放横轴 · 滚轮调区间粗细 · 粉线 = 笑点 · 蓝线 = 留言 · 点击跳转');
    chartHandle = YTEX.chart.render(els.chartCanvas, chartData, {
      // 视口变化（缩放/平移）时更新滚动条
      onViewChange: v => updateChartScroll(v),
    });
    chartHandle.setPosition(YTEX.video.currentTime());
    updateChartScroll();
  }

  function setChart(series) {
    chartData = series;
    renderChartReal();
    renderEmotes();
  }



  // 高频会员表情快捷标记：点击切换"计入发笑"，切换后 chat 会重算并回调 setChart。
  // 列表默认收起（只显示前几个），点击"展开"查看全部。
  let emotesExpanded = false;
  const EMOTES_COLLAPSED_N = 8;

  function renderEmotes() {
    if (!els.emotes) return;
    els.emotes.textContent = '';
    if (!chartData || !YTEX.chat || !YTEX.chat.emoteStats) return;
    const list = YTEX.chat.emoteStats();
    if (!list.length) return;
    const label = document.createElement('span');
    label.className = 'emotes-label';
    label.textContent = I('发笑表情标记：');
    els.emotes.appendChild(label);
    const shown = emotesExpanded ? list : list.slice(0, EMOTES_COLLAPSED_N);
    for (const em of shown) {
      const b = document.createElement('button');
      b.className = 'emote' + (em.marked ? ' on' : '');
      if (em.url) {
        const img = document.createElement('img');
        img.src = em.url;
        img.alt = em.label || em.id;
        img.className = 'emote-img';
        b.appendChild(img);
      }
      const shownTxt = em.label || String(em.id).split(':').pop();
      const txt = document.createElement('span');
      txt.textContent = ` ${shownTxt} ×${em.count}`;
      b.appendChild(txt);
      b.title = `${em.id}\n出现 ${em.count} 次，点击切换是否计入发笑统计`;
      b.addEventListener('click', () => YTEX.chat.toggleEmote(em.id, em));
      els.emotes.appendChild(b);
    }
    if (list.length > EMOTES_COLLAPSED_N) {
      const more = document.createElement('button');
      more.className = 'emote emote-more';
      more.textContent = emotesExpanded ? I('收起') : I('展开（共 {0} 个）', list.length);
      more.addEventListener('click', () => { emotesExpanded = !emotesExpanded; renderEmotes(); });
      els.emotes.appendChild(more);
    }
  }

  function renderRows() {
    const list = els.tsList;
    list.textContent = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = I('暂无时间戳数据——打开视频后自动采集评论区');
      list.appendChild(empty);
    }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.time = r.time;
      row.dataset.key = r.key;

      const cb = document.createElement('input');
      if (tsSelectMode) {
        cb.type = 'checkbox';
        cb.className = 'row-check';
        cb.checked = !tsUnchecked.has(r.key);
        cb.title = '勾选是否导出';
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) tsUnchecked.delete(r.key);
          else tsUnchecked.add(r.key);
          updateTsBar();
        });
      }
      // 当前位置行高亮：距离视频当前位置最近的时间戳行
      if (curNearest && curNearest.key === r.key) row.classList.add('now');
      // 注意：curNearest 在 updateNearestRow() 中维护；首次渲染时按当前时间计算

      const t = document.createElement('span');
      t.className = 't';
      t.textContent = fmt(r.time);

      const main = document.createElement('div');
      main.className = 'main';
      const txt = document.createElement('div');
      txt.className = 'txt';
      if (r.text) appendTextWithEmotes(txt, r.text);
      else txt.textContent = I('(无文本)');
      main.appendChild(txt);

      const more = document.createElement('button');
      more.className = 'more';
      more.classList.toggle('on', expandedRows.has(r.key));
      more.textContent = I('全文');
      more.title = I('查看完整评论及其全部时间戳');

      if (tsSelectMode) row.append(cb);
      row.append(t, main, more);
      list.appendChild(row);

      if (expandedRows.has(r.key)) {
        list.appendChild(buildDetail(r));
      }
    }
    updateTsBar();
    applyDetailFocus();
  }

  // 勾选工具条：仅勾选模式下显示 全选/计数/复制
  function updateTsBar() {
    els.tsSelectBtn.textContent = tsSelectMode ? I('⏹ 退出选择') : I('☑ 选择导出');
    els.tsMaster.style.display = tsSelectMode ? '' : 'none';
    els.tsCount.style.display = tsSelectMode ? '' : 'none';
    els.tsCopyBtn.style.display = tsSelectMode ? '' : 'none';
    if (!tsSelectMode) return;
    const total = rows.length;
    const sel = rows.filter(r => !tsUnchecked.has(r.key)).length;
    els.tsCount.textContent = I('已选 {0}/{1}', sel, total);
    els.tsMaster.checked = total > 0 && sel === total;
    els.tsMaster.indeterminate = sel > 0 && sel < total;
  }

  function copySelectedTimestamps() {
    const sel = rows.filter(r => !tsUnchecked.has(r.key));
    if (!sel.length) { setStatus(I('没有勾选的时间戳可复制')); return; }
    const text = sel
      .map(r => `${fmt(r.time)}　${(r.text || '').trim()}`)   // 保留说明中的原始换行
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      els.tsCopyBtn.textContent = I('已复制');
      setTimeout(() => { els.tsCopyBtn.textContent = I('复制所选'); }, 1200);
    }, () => setStatus(I('复制失败——请检查浏览器剪贴板权限')));
  }

  // 各 Tab 记住自己的滚动位置：切换时保存/恢复，不自动跳到当前位置行
  const tabScroll = {};

  function switchTab(id) {
    const prev = [...els.tabs.children].find(t => t.classList.contains('active'));
    if (prev && els.body) tabScroll[prev.dataset.tab] = els.body.scrollTop;
    for (const t of els.tabs.children) {
      t.classList.toggle('active', t.dataset.tab === id);
    }
    const target = id === 'ai' ? 'secAI' : `sec${id[0].toUpperCase()}${id.slice(1)}`;
    for (const key of ['secTimestamps', 'secChart', 'secNotes', 'secAI', 'secSettings']) {
      els[key].classList.toggle('active', key === target);
    }
    if (id === 'chart') renderChartReal();
    if (id === 'settings') refreshSettings();
    // 恢复目标 Tab 的滚动位置（等一帧让布局生效）
    requestAnimationFrame(() => {
      if (els.body) els.body.scrollTop = tabScroll[id] || 0;
    });
  }

  // 从标记数据推导徽章的渲染信息：图片 URL / Unicode 字符 / 显示文本。
  // 播放器的表情 ID 或无障碍名有时就是图片地址（fonts.gstatic 的 Noto 标准表情、
  // yt3.ggpht 的会员表情），此处统一解析：
  // · Noto 标准 emoji（Unicode）→ 直接用字符显示，不再下载图片；
  // · 会员/自定义表情 → <img> 渲染，无可靠名称时不显示文本；
  // · 文本一律不展示 URL。
  function resolveEmoteDisplay(m, urlMap) {
    const isUrl = v => typeof v === 'string' && /^(https?:)?\/\//.test(v);
    let url = isUrl(m.url) ? m.url : '';
    let label = !isUrl(m.label) ? m.label || '' : '';
    if (!url && isUrl(m.label)) url = m.label;
    if (!url && isUrl(m.id)) url = m.id;
    if (!url && urlMap[m.id]) url = urlMap[m.id];
    // Noto 标准 emoji：从 URL 提取码点（支持 "-" 连接的序列）转成字符
    const noto = url.match(/notoemoji\/[\d.]+\/([0-9a-fA-F-]+)\//);
    if (noto) {
      try {
        const char = noto[1].split('-').map(cp => String.fromCodePoint(parseInt(cp, 16))).join('');
        if (char) return { char, url: '', label };
      } catch {}
    }
    // 显示文本：可靠名称优先；只有 ID 兜底且有图片时省略文本（哈希无意义）；
    // 无图片时截断 ID，保证每个标记都可见
    let text = label;
    let fromId = false;
    if (!text && !isUrl(m.id)) { text = String(m.id).split(':').pop() || m.id; fromId = true; }
    if (!text) { text = m.id; fromId = true; }
    const finalUrl = isUrl(url) ? url : '';
    if (fromId && finalUrl) text = '';
    else if (text.length > 12) text = text.slice(0, 10) + '…';
    return { char: '', url: finalUrl, label: text };
  }

  // 设置 Tab 数据刷新（关键词/表情标记/分桶）
  function refreshSettings() {
    try {
      if (YTEX.keywords) {
        els.kwArea.value = YTEX.keywords.getCustomWords().join('\n');
        // 手动标记的表情：渲染成图片徽章（老标记无 url 时回退为 ID 文本）
        const marks = YTEX.keywords.getEmoteMarks ? YTEX.keywords.getEmoteMarks() : [];
        els.kwEmoteList.textContent = '';
        if (!marks.length) {
          els.kwEmoteList.textContent = I('（无——在「笑点曲线」下方点击表情按钮即可标记）');
        } else {
          const urlMap = {};
          try {
            for (const em of (YTEX.chat.emoteStats ? YTEX.chat.emoteStats() : [])) {
              if (em.url) urlMap[em.id] = em.url;
            }
          } catch {}
          els.kwEmoteList.appendChild(document.createTextNode(`${I('手动标记的表情（{0} 个）：', marks.length)} `));
          for (const m of marks) {
            // 合并持久化表情目录：旧标记没存图片信息的也能解析出图片
            const mm = { ...m };
            if (!mm.url && YTEX.chat.emoteMeta) {
              const meta = YTEX.chat.emoteMeta(m.id);
              if (meta) {
                if (meta.url) mm.url = meta.url;
                if (meta.label && !mm.label) mm.label = meta.label;
              }
            }
            const d = resolveEmoteDisplay(mm, urlMap);
            const chip = document.createElement('span');
            chip.className = 'emote-mark-chip';
            chip.title = m.id;
            if (d.char) {
              const c = document.createElement('span');
              c.className = 'emote-char';
              c.textContent = d.char;
              chip.appendChild(c);
            }
            if (d.url) {
              const img = document.createElement('img');
              img.src = d.url;
              img.className = 'emote-img';
              chip.appendChild(img);
            }
            if (d.label) chip.appendChild(document.createTextNode(d.label));
            els.kwEmoteList.appendChild(chip);
          }
        }
      }
    } catch {}
  }

  // ---------- 交互 ----------

  function seekAndReport(sec, sourceLabel) {
    const t = YTEX.video.seekTo(sec);
    if (t === null) {
      setStatus('当前页面没有可用的播放器');
    } else if (sourceLabel) {
      setStatus(I('已跳转 {0}（{1}）', fmt(t), sourceLabel));
    }
  }

  function flashRow(time) {
    let best = null;
    let bestDiff = Infinity;
    for (const el of els.tsList.querySelectorAll('.row[data-time]')) {
      const diff = Math.abs(Number(el.dataset.time) - time);
      if (diff < bestDiff) { bestDiff = diff; best = el; }
    }
    if (best && bestDiff <= 1) {
      best.classList.remove('flash');
      void best.offsetWidth; // 重启动画
      best.classList.add('flash');
      // 不做 scrollIntoView：从详情/快速跳转发起时不应拖动列表滚动位置
    }
  }

  // 当前位置行：距视频播放位置最近的时间戳行标 .now，并让列表自动跟随
  let curNearestEl = null;         // 当前最近行 DOM 元素（切 Tab / 开面板时强制居中用）
  function updateNearestRow() {
    const rowsDom = els.tsList.querySelectorAll('.row[data-time]');
    if (!rowsDom.length) { curNearest = null; curNearestEl = null; return; }
    let cur = 0;
    try { cur = Number(YTEX.video.currentTime()) || 0; } catch {}
    // 高亮规则：当前时间之前（≤当前时间）的最后一个时间戳；之前没有则高亮第一个
    let best = null;
    let bestDiff = Infinity;
    let firstEl = null;
    for (const el of rowsDom) {
      if (!firstEl) firstEl = el;
      const t = Number(el.dataset.time);
      if (t <= cur && (!best || t > Number(best.dataset.time))) best = el;
    }
    if (!best) best = firstEl;
    const key = best ? best.dataset.key : null;
    // 无变化则跳过；但重渲染后旧元素已脱离文档（isConnected=false），需重新认领
    if (curNearest && curNearest.key === key && curNearestEl && curNearestEl.isConnected) return;
    curNearest = key ? { key, time: Number(best.dataset.time) } : null;
    curNearestEl = best;
    for (const el of rowsDom) el.classList.toggle('now', el === best);
    followNearest(false);
  }

  // 自动跟随：把当前位置行滚到面板滚动容器（.body）可视区正中。
  // 仅在时间戳 Tab 可见时滚动；force=true 忽略手动滚动暂停（切到时间戳 Tab / 打开面板时）。
  // 只滚动面板内部容器，不波及宿主页面。用瞬时滚动：进行中的平滑滚动会与后续
  // scrollTop 赋值互相打架（展开全文定位失效的根因），故不再用 smooth。
  function followNearest(force) {
    const best = curNearestEl;
    if (!best) return;
    if (!force && Date.now() < followPausedUntil) return;
    if (!els.secTimestamps.classList.contains('active')) return;
    const box = els.body;
    if (!box) return;
    const br = box.getBoundingClientRect();
    const rr = best.getBoundingClientRect();
    if (!br.height || !rr.height) return;
    const top = box.scrollTop + rr.top - br.top - (br.height - rr.height) / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }

  function setStatus(a, b) {
    // setStatus('文本') → 公共段；setStatus('comments'|'chat', '文本') → 分轨状态
    if (b === undefined) statusParts.common = a || '';
    else statusParts[a] = b || '';
    els.status.textContent = [statusParts.comments, statusParts.chat, statusParts.common]
      .filter(Boolean).join(' ｜ ');
  }

  function bindEvents() {
    // 打开面板由悬浮球的 pointerup 处理（点击/拖动区分）
    els.min.addEventListener('click', () => close());
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
    });

    // 全屏时自动隐藏（含 FAB），退出恢复
    document.addEventListener('fullscreenchange', () => {
      host.classList.toggle('hidden', !!document.fullscreenElement);
    });

    for (const t of els.tabs.children) {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    }

    // 列表点击：chip → 跳转；全文 → 展开/收起详情；行 → 跳转（事件委托）
    els.tsList.addEventListener('click', e => {
      const chip = e.target.closest('.chip[data-time]');
      if (chip) { seekAndReport(Number(chip.dataset.time), I('评论详情')); return; }
      const more = e.target.closest('.more');
      if (more) {
        const row0 = more.closest('.row');
        const key = row0?.dataset.key;
        if (key) {
          const expanding = !expandedRows.has(key);
          if (expanding) {
            expandedRows.clear();   // 单一全文：打开新的前先收起其他已展开的
            expandedRows.add(key);
            // 详情框定位请求：框内滚到该行对应的时间戳行；8s 内的重渲染都保持定位
            detailFocusReq = { key, time: Number(row0.dataset.time), until: Date.now() + 8000 };
          } else {
            expandedRows.delete(key);
            detailFocusReq = null;
          }
          renderRows();
        }
        return;
      }
      const row = e.target.closest('.row[data-time]');
      if (row) seekAndReport(Number(row.dataset.time), I('时间戳列表'));
    });

    // 用户手动滚动面板时暂停自动跟随 10s（滚轮/触屏/拖滚动条），
    // 跳转时间戳（ytex:seek）后立即恢复跟随
    const pauseFollow = () => { followPausedUntil = Date.now() + 10000; };
    els.body.addEventListener('wheel', pauseFollow, { passive: true });
    els.body.addEventListener('touchmove', pauseFollow, { passive: true });
    els.body.addEventListener('pointerdown', pauseFollow);

    // 主题切换（持久化到 chrome.storage.local，默认浅色）
    els.themeLight.addEventListener('click', () => setTheme('light'));
    els.themeDark.addEventListener('click', () => setTheme('dark'));

    // 笔记重点标记符号（自定义，持久化）
    els.markerInput.addEventListener('input', () => {
      noteMarker = els.markerInput.value.trim() || '★';
      try { chrome.storage.local.set({ ytexNoteMarker: noteMarker }); } catch {}
      syncMarkerUI();
    });

    // 笔记：插入时间戳（自动暂停）/ 模板 / 复制；输入自动保存
    els.noteTsBtn.addEventListener('click', () => {
      const t = YTEX.video.currentTime();
      const v = YTEX.video.el();
      if (!v || !isFinite(t)) { setStatus(I('笔记：当前页面没有可用的播放器')); return; }
      if (notePauseOnInsert) { try { v.pause(); } catch {} }
      insertIntoNotes(`${fmt(t)}　`);
      els.notesHint.textContent = I('已插入 {0}，继续补充说明即可{1}', fmt(t), notePauseOnInsert ? I('（视频已暂停）') : '');
    });
    els.notePauseBtn.addEventListener('click', () => {
      notePauseOnInsert = !notePauseOnInsert;
      syncPauseBtn();
      try { chrome.storage.local.set({ ytexNotePause: notePauseOnInsert }); } catch {}
    });

    // AI 总结：生成 / 复制 / 输出内时间戳可点击
    els.aiGenBtn.addEventListener('click', async () => {
      if (YTEX.ai.isGenerating()) return;
      saveAiCfg();
      const genVid = aiVid || YTEX.video.videoId();   // 生成可能很久，先记下是哪个视频的总结
      els.aiGenBtn.textContent = I('生成中…');
      els.aiGenBtn.disabled = true;
      els.aiOut.textContent = '';
      try {
        const text = await YTEX.ai.generate(
          phase => {
            els.aiGenBtn.textContent = phase === 'gather'
              ? I('正在聚合素材（字幕/评论/聊天）…')
              : I('正在请求大模型生成…');
          },
          bytes => {
            els.aiGenBtn.textContent = I('生成中…（已接收 {0} 字节）', bytes);
          },
        );
        els.aiRaw = text;
        renderAiOutput(text);
        els.aiCopyBtn.disabled = false;
        els.aiGenBtn.textContent = I('生成总结');
        els.aiGenBtn.disabled = false;
        // 写入缓存（按视频 ID），刷新页面后自动恢复
        YTEX.ai.cacheSummary(genVid, text).then(() => {
          if (aiVid === genVid) {
            els.aiMeta.textContent = I('总结已缓存（生成于 {0}）· 刷新页面后自动恢复', fmtWhen(Date.now()));
          }
        });
      } catch (err) {
        els.aiGenBtn.textContent = I('生成总结');
        els.aiGenBtn.disabled = false;
        els.aiOut.textContent = I('生成失败：{0}', err.message);
      }
    });
    els.aiCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(els.aiRaw || els.aiOut.textContent);
        els.aiCopyBtn.textContent = I('已复制');
        setTimeout(() => { els.aiCopyBtn.textContent = I('复制'); }, 1200);
      } catch {}
    });
    els.aiOut.addEventListener('click', e => {
      const chip = e.target.closest('.notes-ts[data-time]');
      if (chip) seekAndReport(Number(chip.dataset.time), I('AI 总结'));
    });
    // 清除本视频的 AI 总结缓存（不影响已显示内容，重新生成后会再次写入）
    els.aiCacheBtn.addEventListener('click', () => {
      const vid = aiVid || YTEX.video.videoId();
      if (!vid) { setStatus(I('非视频页，无缓存可清除')); return; }
      YTEX.ai.clearCachedSummary(vid).then(ok => {
        els.aiMeta.textContent = ok ? '' : els.aiMeta.textContent;
        els.aiCacheBtn.textContent = ok ? I('已清除') : I('清除失败');
        setStatus(ok ? I('已清除本视频的 AI 总结缓存') : I('清除失败，请重试'));
        setTimeout(() => { els.aiCacheBtn.textContent = I('清除缓存'); }, 1500);
      });
    });
    // 字幕下载：把所选轨道转成 SRT 并保存为文件
    els.subsBtn.addEventListener('click', async () => {
      const tr = subsCache && subsCache.tracks ? subsCache.tracks[Number(els.subsSel.value) || 0] : null;
      if (!tr) return;
      els.subsBtn.disabled = true;
      els.subsBtn.textContent = I('下载中…');
      try {
        const srt = await YTEX.subs.fetchSrt(tr, subsCache.vid);
        const base = (subsCache.title || subsCache.vid).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip' }));
        a.download = `${base}.${tr.code || 'srt'}${tr.asr ? '.auto' : ''}.srt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        els.subsBtn.textContent = I('已下载');
        setStatus(I('字幕已下载：{0}', a.download));
      } catch (err) {
        setStatus(I('字幕下载失败：{0}', String((err && err.message) || err).slice(0, 100)));
      }
      els.subsBtn.disabled = false;
      setTimeout(() => { els.subsBtn.textContent = I('下载 SRT'); }, 1500);
    });
    // 封面下载：maxres → sd → hq 逐级回退（i.ytimg.com，未提供高清时自动降级）
    els.thumbBtn.addEventListener('click', async () => {
      const vid = YTEX.video.videoId();
      if (!vid) { setStatus(I('非视频页')); return; }
      els.thumbBtn.disabled = true;
      try {
        const base = ((subsCache && subsCache.title) || vid).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        for (const f of ['maxresdefault.jpg', 'sddefault.jpg', 'hqdefault.jpg']) {
          try {
            const res = await fetch(`https://i.ytimg.com/vi/${vid}/${f}`);
            if (!res.ok) continue;
            const blob = await res.blob();
            if (blob.size < 1000) continue;   // 过滤灰色占位图
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${base}.${f.split('.')[0]}.jpg`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            setStatus(I('封面已下载：{0}', a.download));
            els.thumbBtn.disabled = false;
            return;
          } catch {}
        }
        setStatus(I('封面下载失败'));
      } finally {
        els.thumbBtn.disabled = false;
      }
    });
    for (const inp of [els.aiUrl, els.aiKey, els.aiModel]) {
      inp.addEventListener('change', saveAiCfg);
    }
    els.aiOutLang.addEventListener('change', saveAiCfg);
    // 追问：发送按钮 / Enter 提交
    els.aiFollowBtn.addEventListener('click', submitFollow);
    els.aiFollowInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.stopPropagation(); submitFollow(); }
    });
    // 清空对话：清除持久化历史并复位列表（ai.js 的存储同步清除）
    els.aiFollowClear.addEventListener('click', () => {
      const vid = aiVid;
      if (!vid) { setStatus(I('非视频页')); return; }
      YTEX.ai.resetFollowup(vid);
      aiFollowHist.delete(vid);
      renderFollowHist([]);   // 立即清空显示（存储由 ai.js 异步清除，避免渲染读到旧数据）
    });
    els.aiType.addEventListener('change', saveAiCfg);
    els.aiGlossMax.addEventListener('change', saveAiCfg);

    // 时间戳勾选导出：进入/退出勾选模式 + 全选/全不选 + 复制所选
    els.tsSelectBtn.addEventListener('click', () => {
      tsSelectMode = !tsSelectMode;
      if (!tsSelectMode) tsUnchecked.clear();
      renderRows();
    });
    els.tsMaster.addEventListener('change', () => {
      if (els.tsMaster.checked) tsUnchecked.clear();
      else rows.forEach(r => tsUnchecked.add(r.key));
      renderRows();
    });
    els.tsCopyBtn.addEventListener('click', copySelectedTimestamps);
    // 工具条：回到顶部 / 跳到当前位置行（跳转即解除手动滚动暂停，恢复自动跟随）
    els.tsTopBtn.addEventListener('click', () => { els.body.scrollTop = 0; });
    els.tsCurBtn.addEventListener('click', () => {
      followPausedUntil = 0;
      updateNearestRow();
      followNearest(true);
    });

    // 设置：发笑关键词保存 / 表情标记清除 / 分桶粒度
    els.kwSaveBtn.addEventListener('click', () => {
      const words = els.kwArea.value.split('\n').map(s => s.trim()).filter(Boolean);
      YTEX.keywords.setCustomWords(words);
      els.kwSaveBtn.textContent = I('已保存');
      setTimeout(() => { els.kwSaveBtn.textContent = I('保存关键词'); }, 1200);
    });
    els.kwClearBtn.addEventListener('click', () => {
      YTEX.keywords.clearEmoteMarks();
      refreshSettings();
      els.kwClearBtn.textContent = I('已清除');
      setTimeout(() => { els.kwClearBtn.textContent = I('清除表情标记'); }, 1200);
    });
    els.noteSecBtn.addEventListener('click', () => insertIntoNotes('【】', 1));
    els.noteSubBtn.addEventListener('click', () => insertIntoNotes('　　└ '));
    els.noteMarkBtn.addEventListener('click', () => toggleMarkerSelection());
    els.noteIndentBtn.addEventListener('click', () => indentSelection(true));
    els.noteOutdentBtn.addEventListener('click', () => indentSelection(false));
    els.noteCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(els.notesArea.value);
        els.noteCopyBtn.textContent = I('已复制');
        setTimeout(() => { els.noteCopyBtn.textContent = I('复制'); }, 1200);
      } catch {
        setStatus(I('笔记复制失败——请在编辑框内手动全选复制'));
      }
    });
    els.notesArea.addEventListener('input', () => {
      scheduleSaveNotes();
      renderNotesPreview();
    });

    // 采集开关：默认关闭，手动开始/停止（长视频防止内存与流量开销）
    els.chatStartBtn.addEventListener('click', () => {
      if (YTEX.chat.isCollecting()) { YTEX.chat.stopManual(); return; }
      if (!YTEX.video.videoId()) { setStatus(I('非视频页')); return; }
      YTEX.chat.beginManual();
    });
    const syncChatBtn = () => {
      if (YTEX.chat.isCollecting()) {
        els.chatStartBtn.disabled = false;
        els.chatStartBtn.textContent = I('⏹ 停止采集');
        els.chatStartBtn.classList.remove('ghost');
      } else if (YTEX.chat.isDone()) {
        // 采集完成：置灰不可点；清除缓存后恢复为「▶ 开始采集」
        els.chatStartBtn.disabled = true;
        els.chatStartBtn.textContent = I('✓ 采集完成');
        els.chatStartBtn.classList.add('ghost');
      } else {
        els.chatStartBtn.disabled = false;
        els.chatStartBtn.textContent = I('▶ 开始采集');
        els.chatStartBtn.classList.add('ghost');
      }
    };
    setInterval(syncChatBtn, 800);
    syncChatBtn();
    els.cacheBtn.addEventListener('click', () => {
      const vid = YTEX.video.videoId();
      if (!vid) { setStatus(I('非视频页，无缓存可清除')); return; }
      try {
        chrome.storage.local.remove([`ytexChat:${vid}`], () => {
          els.cacheBtn.textContent = I('已清除');
          YTEX.chat.markNotDone();
          syncChatBtn();
          setStatus(I('已清除该视频聊天缓存，重新打开视频后将重新全量采集'));
          setTimeout(() => { els.cacheBtn.textContent = I('清除本视频聊天缓存'); }, 1500);
        });
      } catch {}
    });

    els.langSel.addEventListener('change', () => {
      YTEX.i18n.setLang(els.langSel.value);
      applyTexts();
    });

    // 笔记预览：时间戳点击跳转；±1s 微调按钮
    els.notesPreview.addEventListener('click', e => {
      const adj = e.target.closest('.notes-adj[data-line]');
      if (adj) { adjustLineTs(Number(adj.dataset.line), Number(adj.dataset.delta)); return; }
      const chip = e.target.closest('.notes-ts[data-time]');
      if (chip) seekAndReport(Number(chip.dataset.time), I('笔记预览'));
    });

    // 曲线交互：hover 十字提示、点击跳转、Ctrl+滚轮调整区间粒度、播放位置指示
    els.chartCanvas.addEventListener('mousemove', e => {
      if (chartHandle) chartHandle.hover(chartHandle.hitTest(e.offsetX, e.offsetY));
    });
    els.chartCanvas.addEventListener('mouseleave', () => {
      if (chartHandle) chartHandle.hover(null);
    });
    els.chartCanvas.addEventListener('click', e => {
      if (!chartHandle) return;
      // 图例点击：切换对应折线显示（不触发跳转）
      if (chartHandle.legendHit(e.offsetX, e.offsetY)) return;
      const t = chartHandle.timeAt(e.offsetX);
      if (t !== null) seekAndReport(t, I('曲线'));
    });
    els.chartCanvas.addEventListener('wheel', e => {
      if (!chartHandle || !chartData) return;
      e.preventDefault();
      const t = chartHandle.timeAt(e.offsetX);
      if (e.ctrlKey) {
        // Ctrl+滚轮：横轴缩放（鼠标处为锚）
        chartHandle.zoom(e.deltaY < 0 ? 1.5 : 1 / 1.5, t);
      } else {
        // 只滚轮：调整区间粗细（重算桶宽 5–300s，保持当前横轴视口不重置）
        const base = viewBucket || chartData.bucketSec;
        viewBucket = Math.min(300, Math.max(5, Math.round(base * (e.deltaY < 0 ? 0.5 : 2))));
        const series = YTEX.chat.getSeries(viewBucket);
        if (series) {
          const savedView = chartHandle.view();
          chartData = series;
          renderChartReal();
          // 恢复原视口：横轴时间范围保持不变
          if (chartHandle) chartHandle.setView(savedView);
        }
      }
    }, { passive: false });
    // 滚动条拖动：滑块平移时间窗口（保持窗口宽度不变）
    let scrollDrag = null;
    els.chartScroll.addEventListener('pointerdown', e => {
      if (!chartHandle) return;
      e.preventDefault();
      els.chartScroll.setPointerCapture(e.pointerId);
      const rect = els.chartScroll.getBoundingClientRect();
      const v = chartHandle.view();
      const span = v.end - v.start;
      // 点击滑块外：让滑块中心跳到点击处；点击滑块内：按偏移拖动
      const thumbRatio = span / (v.duration || 1);
      const clickRatio = (e.clientX - rect.left) / rect.width;
      const thumbCenter = v.start / (v.duration || 1) + thumbRatio / 2;
      const isOnThumb = Math.abs(clickRatio - thumbCenter) <= thumbRatio / 2;
      scrollDrag = {
        span,
        grabOffset: isOnThumb ? clickRatio - v.start / (v.duration || 1) : thumbRatio / 2,
      };
      const apply = ratio => {
        // grabOffset 以全片比例存储：start = (ratio - grabOffset) * duration
        const start = Math.max(0, Math.min((v.duration || 1) - span, (ratio - scrollDrag.grabOffset) * (v.duration || 1)));
        chartHandle.setView({ start, end: start + span });
      };
      apply(clickRatio);
      const onMove = ev => {
        if (!scrollDrag) return;
        apply((ev.clientX - rect.left) / rect.width);
      };
      const onUp = () => {
        scrollDrag = null;
        els.chartScroll.removeEventListener('pointermove', onMove);
        els.chartScroll.removeEventListener('pointerup', onUp);
      };
      els.chartScroll.addEventListener('pointermove', onMove);
      els.chartScroll.addEventListener('pointerup', onUp);
    });

    // 播放位置指示线随播放更新；时间戳列表当前位置行同步跟随
    setInterval(() => {
      if (chartHandle && chartData && YTEX.video.el()) {
        chartHandle.setPosition(YTEX.video.currentTime());
      }
      updateNearestRow();
    }, 500);

    // 时间轴叠加：开关/背景透明度/折线透明度（实时生效并持久化；调节时叠加层自动出现预览）
    const applyOverlay = (key, value) => {
      try { chrome.storage.local.set({ [key]: value }); } catch {}
      if (!YTEX.overlay) return;
      if (key === 'ytexOverlayEnabled') YTEX.overlay.setEnabled(value);
      if (key === 'ytexOverlayBgOpacity') YTEX.overlay.setBgOpacity(value);
      if (key === 'ytexOverlayOpacity') YTEX.overlay.setLineOpacity(value);
      if (key === 'ytexOverlayTsDots') YTEX.overlay.setTsDots(value);
      if (key.startsWith('ytexOverlayOpacity')) YTEX.overlay.preview();   // 透明度调节时预览效果
    };
    els.overlayToggle.addEventListener('change', () => applyOverlay('ytexOverlayEnabled', els.overlayToggle.checked));
    els.overlayTsDots.addEventListener('change', () => applyOverlay('ytexOverlayTsDots', els.overlayTsDots.checked));
    els.overlayBg.addEventListener('input', () => applyOverlay('ytexOverlayBgOpacity', Number(els.overlayBg.value)));
    els.overlayLine.addEventListener('input', () => applyOverlay('ytexOverlayOpacity', Number(els.overlayLine.value)));

    // 图表高度拖拽调整（120–560px，持久化）
    let chartH = 0;
    try {
      chrome.storage.local.get(['ytexChartH'], d => {
        if (d && d.ytexChartH >= 120) {
          els.chartCanvas.style.height = `${d.ytexChartH}px`;
        }
      });
    } catch {}
    els.chartGrip.addEventListener('pointerdown', e => {
      e.preventDefault();
      els.chartGrip.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = els.chartCanvas.clientHeight || 170;
      const onMove = ev => {
        // 手柄在图表下方：往上拖（deltaY<0）= 拉长，往下拖 = 压缩
        chartH = Math.min(560, Math.max(120, startH + (ev.clientY - startY)));
        els.chartCanvas.style.height = `${chartH}px`;
      };
      const onUp = () => {
        els.chartGrip.removeEventListener('pointermove', onMove);
        els.chartGrip.removeEventListener('pointerup', onUp);
        if (chartH) {
          try { chrome.storage.local.set({ ytexChartH: chartH }); } catch {}
        }
      };
      els.chartGrip.addEventListener('pointermove', onMove);
      els.chartGrip.addEventListener('pointerup', onUp);
    });

    // 面板拉宽/收窄时图表自适应重绘（保持当前视口与折线开关）
    let chartResizeTimer = 0;
    let chartLastW = 0;
    let chartLastH = 0;
    const ro = new ResizeObserver(() => {
      if (!chartData || !els.chartCanvas) return;
      const w = els.chartCanvas.clientWidth;
      const h = els.chartCanvas.clientHeight;
      // 宽度或高度任一变化都触发重绘（高度拖拽时按新高度重新绘制，而非拉伸）
      if (!w || (w === chartLastW && h === chartLastH)) return;
      chartLastW = w;
      chartLastH = h;
      if (chartResizeTimer) clearTimeout(chartResizeTimer);
      chartResizeTimer = setTimeout(() => {
        chartResizeTimer = 0;
        if (!chartData) return;
        const savedView = chartHandle ? chartHandle.view() : null;
        renderChartReal();
        if (chartHandle && savedView) chartHandle.setView(savedView);
      }, 120);
    });
    ro.observe(els.chartCanvas);

    // seek 后高亮列表对应行（不滚动列表）
    document.addEventListener('ytex:seek', e => { flashRow(e.detail.time); followPausedUntil = 0; });

    // 左边缘拖拽调宽（锁定时禁用）
    els.resize.addEventListener('pointerdown', e => {
      if (panelLocked) return;   // 锁定：禁止调整面板宽度
      e.preventDefault();
      els.resize.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = els.panel.getBoundingClientRect().width;
      const startRight = els.panel.getBoundingClientRect().right;
      const onMove = ev => {
        const w = Math.min(Math.max(startW + (startX - ev.clientX), MIN_W), window.innerWidth * 0.6);
        els.panel.style.width = `${w}px`;
        if (freeMode && leftOffset !== null) {
          // 自由模式：右缘固定，左缘随宽度伸缩（面板以 left 定位，加宽需同步左移）
          leftOffset = Math.max(8, startRight - w);
          els.panel.style.left = `${leftOffset}px`;
        }
      };
      const onUp = () => {
        els.resize.removeEventListener('pointermove', onMove);
        els.resize.removeEventListener('pointerup', onUp);
        resetInputScroll();   // 拖宽后同样复位输入框残留滚动
        // 自由模式：拖完的宽度与位置一并持久化（刷新后原样恢复）
        if (freeMode) {
          freeSize = { ...(freeSize || {}), w: els.panel.getBoundingClientRect().width };
          try { chrome.storage.local.set({ ytexFreeSize: freeSize }); } catch {}
          if (leftOffset !== null) {
            try { chrome.storage.local.set({ ytexFreePos: { left: leftOffset, top: topOffset } }); } catch {}
          }
        }
      };
      els.resize.addEventListener('pointermove', onMove);
      els.resize.addEventListener('pointerup', onUp);
    });

    // header 垂直拖动整块面板
    els.header.addEventListener('pointerdown', e => {
      if (e.target.closest('.tab, button')) return;
      if (panelLocked) return;   // 锁定：禁止拖动面板
      e.preventDefault();
      els.header.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startX = e.clientX;
      const startLeft = freeMode && leftOffset !== null ? leftOffset : els.panel.getBoundingClientRect().left;
      const startTop = topOffset ?? els.panel.getBoundingClientRect().top;
      const maxTop = window.innerHeight - 80;
      const onMove = ev => {
        topOffset = Math.min(Math.max(startTop + (ev.clientY - startY), 8), maxTop);
        els.panel.style.top = `${topOffset}px`;
        if (freeMode) {
          // 自由模式：整块面板可水平移动
          leftOffset = Math.min(Math.max(startLeft + (ev.clientX - startX), 8), window.innerWidth - 80);
          els.panel.style.left = `${leftOffset}px`;
        }
      };
      const onUp = () => {
        els.header.removeEventListener('pointermove', onMove);
        els.header.removeEventListener('pointerup', onUp);
        if (freeMode) {
          try { chrome.storage.local.set({ ytexFreePos: { left: leftOffset, top: topOffset } }); } catch {}
        } else if (topOffset !== null) {
          try { chrome.storage.local.set({ ytexTopOffset: topOffset }); } catch {}
        }
      };
      els.header.addEventListener('pointermove', onMove);
      els.header.addEventListener('pointerup', onUp);
    });
  }

  // 面板透明度：只调节背景底色的不透明度，文字/控件保持不透明
  function applyPanelOpacity() {
    if (!els.panel) return;
    // --bg 为十六进制主题色 → rgba 底色（自由/吸附模式均生效）
    const hex = (getComputedStyle(els.panel).getPropertyValue('--bg') || '#ffffff').trim();
    const n = parseInt(hex.replace('#', ''), 16);
    if (Number.isFinite(n)) {
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      els.panel.style.background = `rgba(${r}, ${g}, ${b}, ${panelOpacity})`;
    }
  }

  // 背景模糊度：backdrop-filter 模糊面板身后的页面内容
  function applyPanelBlur() {
    if (!els.panel) return;
    els.panel.style.backdropFilter = panelBlur > 0 ? `blur(${panelBlur}px)` : 'none';
  }

  // 自由/吸附模式切换：自由模式解除右侧吸附，位置尺寸完全自由，并启用背景半透明+模糊
  function applyFreeMode() {
    if (!els.panel) return;
    els.panel.classList.toggle('panel-free', freeMode);
    if (freeMode) {
      els.panel.style.right = 'auto';
      // 首次开启（无已存位置）：默认位于距页面右侧 200px 处；
      // 用户拖动过（内存/存储有位置）则取消后重新勾选原位恢复
      const rect = els.panel.getBoundingClientRect();
      if (leftOffset === null) {
        const w = rect.width || els.panel.offsetWidth || 360;
        leftOffset = Math.max(8, window.innerWidth - w - 200);
      }
      if (topOffset === null) topOffset = Math.max(8, Math.min(rect.top, window.innerHeight - 80));
      els.panel.style.left = `${leftOffset}px`;
      els.panel.style.top = `${topOffset}px`;
      if (freeSize) {
        els.panel.style.width = `${freeSize.w}px`;
        els.panel.style.height = `${freeSize.h}px`;
      }
      // 半透明背景 + 背景模糊（模糊度>0 时生效）
      els.panel.style.borderRadius = '12px';
      els.panel.style.borderRight = '1px solid var(--border)';
      applyPanelOpacity();
      applyPanelBlur();
    } else {
      // 回到吸附：清除内联覆盖，恢复右侧吸附与主题背景
      els.panel.style.left = '';
      els.panel.style.right = '';
      els.panel.style.top = topOffset !== null ? `${topOffset}px` : '';
      els.panel.style.background = '';
      els.panel.style.backdropFilter = '';
      els.panel.style.borderRadius = '';
      els.panel.style.borderRight = 'none';
    }
    els.panel.classList.toggle('panel-locked', panelLocked);
  }

  // ---------- 构建 DOM ----------

  function build() {
    host = document.createElement('div');
    host.id = 'ytex-panel-host';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = YTEX.PANEL_CSS;

    els.fab = document.createElement('button');
    els.fab.className = 'fab';
    els.fab.title = I('高光时刻');
    els.fab.textContent = '⏱';
    // 悬停浮现的小 × ：点击移除悬浮球（pointerdown 阻断冒泡，避免触发"点击打开面板"）
    const fabClose = document.createElement('span');
    fabClose.className = 'fab-close';
    fabClose.textContent = '×';
    fabClose.title = I('移除悬浮球');
    fabClose.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); });
    fabClose.addEventListener('click', e => {
      e.stopPropagation();
      setFabHidden(true);
      setStatus(I('悬浮球已移除：点击浏览器工具栏的本扩展图标可恢复'));
    });
    els.fab.appendChild(fabClose);
    // 悬浮球可上下拖动并记忆位置（点击与拖动按位移阈值区分）
    els.fab.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startTop = els.fab.getBoundingClientRect().top;
      let moved = false;
      const onMove = ev => {
        const dy = ev.clientY - startY;
        if (Math.abs(dy) < 5 && !moved) return;
        moved = true;
        els.fab.classList.add('dragging');
        const vh = window.innerHeight;
        const top = Math.max(6, Math.min(startTop + dy, vh - els.fab.offsetHeight - 6));
        els.fab.style.top = `${top}px`;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        els.fab.classList.remove('dragging');
        if (moved) {
          try { chrome.storage.local.set({ ytexFabTop: parseFloat(els.fab.style.top) }); } catch {}
        } else {
          open();   // 未拖动 = 点击：打开面板
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    // 右键悬浮球：直接移除（点击工具栏图标恢复）
    els.fab.addEventListener('contextmenu', e => {
      e.preventDefault();
      setFabHidden(true);
      setStatus(I('悬浮球已移除：点击浏览器工具栏的本扩展图标可恢复'));
    });
    // 恢复上次拖动的位置
    try {
      chrome.storage.local.get(['ytexFabTop'], d => {
        if (d && typeof d.ytexFabTop === 'number') els.fab.style.top = `${d.ytexFabTop}px`;
      });
    } catch {}

    els.panel = document.createElement('div');
    els.panel.className = 'panel';

    els.resize = document.createElement('div');
    els.resize.className = 'resize-handle';
    els.resize.title = '拖拽调宽';

    els.header = document.createElement('div');
    els.header.className = 'header';
    const logo = document.createElement('span');
    logo.className = 'logo';
    logo.textContent = '⏱';
    els.tabs = document.createElement('div');
    els.tabs.className = 'tabs';
    for (const [id, label] of [['timestamps', '时间戳'], ['chart', '笑点曲线'], ['notes', '笔记'], ['ai', '总结'], ['settings', '设置']]) {
      const tab = document.createElement('span');
      tab.className = 'tab';
      tab.dataset.tab = id;
      tab.textContent = label;
      els.tabs.appendChild(tab);
    }
    els.min = document.createElement('button');
    els.min.className = 'min';
    els.min.title = '收起 (Esc)';
    els.min.textContent = '—';
    els.header.append(logo, els.tabs, els.min);

    // Tab 1：时间戳列表
    els.secTimestamps = document.createElement('div');
    els.secTimestamps.className = 'sec';
    els.secTimestamps.id = 'sec-timestamps';
    const tsBar = document.createElement('div');
    tsBar.className = 'ts-toolbar';
    els.tsSelectBtn = document.createElement('button');
    els.tsSelectBtn.className = 'btn ghost';
    els.tsSelectBtn.textContent = I('☑ 选择导出');
    els.tsSelectBtn.title = '进入勾选模式：选择要复制的时间戳';
    els.tsMaster = document.createElement('input');
    els.tsMaster.type = 'checkbox';
    els.tsMaster.checked = true;
    els.tsMaster.title = '全选 / 全不选';
    els.tsCount = document.createElement('span');
    els.tsCount.className = 'ts-count';
    els.tsCopyBtn = document.createElement('button');
    els.tsCopyBtn.className = 'btn ghost';
    els.tsCopyBtn.textContent = I('复制所选');
    els.tsCopyBtn.title = '按时间顺序复制勾选的时间戳及说明';
    // 常驻工具：回到顶部 / 跳到当前位置行（固定在工具条右侧，随工具条吸顶）
    els.tsTopBtn = document.createElement('button');
    els.tsTopBtn.className = 'btn ghost push';
    els.tsTopBtn.textContent = I('⬆ 顶部');
    els.tsTopBtn.title = I('回到列表顶部');
    els.tsCurBtn = document.createElement('button');
    els.tsCurBtn.className = 'btn ghost';
    els.tsCurBtn.textContent = I('⌖ 当前位置');
    els.tsCurBtn.title = I('滚动到距播放位置最近的时间戳，并恢复自动跟随');
    tsBar.append(els.tsSelectBtn, els.tsMaster, els.tsCount, els.tsCopyBtn, els.tsTopBtn, els.tsCurBtn);
    els.tsList = document.createElement('div');
    els.tsList.id = 'ts-list';
    els.secTimestamps.append(tsBar, els.tsList);

    // Tab 2：笑点曲线
    els.secChart = document.createElement('div');
    els.secChart.className = 'sec';
    els.secChart.id = 'sec-chart';
    const chartWrap = document.createElement('div');
    chartWrap.className = 'chart-wrap';
    els.chartCanvas = document.createElement('canvas');
    els.chartCanvas.className = 'chart-canvas';
    els.chartCanvas.height = 170;
    els.chartNote = document.createElement('div');
    els.chartNote.className = 'chart-note';
    els.chartNote.textContent = '尚无聊天数据——见底部状态栏说明';
    els.chartGrip = document.createElement('div');
    els.chartGrip.className = 'chart-grip';
    els.chartGrip.title = I('拖拽调整图表高度');
    // 横向滚动条（放大后出现）：拖动滑块前后平移时间窗口
    els.chartScroll = document.createElement('div');
    els.chartScroll.className = 'chart-scroll';
    els.chartScrollThumb = document.createElement('div');
    els.chartScrollThumb.className = 'chart-scroll-thumb';
    els.chartScroll.appendChild(els.chartScrollThumb);
    chartWrap.append(els.chartCanvas, els.chartScroll, els.chartGrip, els.chartNote);
    els.emotes = document.createElement('div');
    els.emotes.className = 'emotes';
    // 时间轴叠加设置：开关 + 背景/折线透明度（调节时叠加层自动出现预览）。
    // 布局：开关独占一行；两个透明度各占一行（标签 + 滑杆），网格对齐不换行。
    const overlaySet = document.createElement('div');
    overlaySet.className = 'overlay-set';
    const overlayToggleWrap = document.createElement('div');
    overlayToggleWrap.className = 'overlay-toggle-wrap';
    els.overlayToggle = document.createElement('input');
    els.overlayToggle.type = 'checkbox';
    els.overlayToggle.id = 'ytex-overlay-toggle';
    const overlayToggleLabel = document.createElement('label');
    overlayToggleLabel.htmlFor = 'ytex-overlay-toggle';
    overlayToggleLabel.textContent = I('在视频进度条上方显示笑点曲线');
    els.overlayToggleLabel = overlayToggleLabel;   // 语言切换重译用
    overlayToggleWrap.append(els.overlayToggle, overlayToggleLabel);
    const mkRange = () => {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = '0.1';
      r.max = '1';
      r.step = '0.05';
      r.title = I('调节时可在视频进度条上方预览效果');
      return r;
    };
    els.overlayBg = mkRange();
    const overlayBgLabel = document.createElement('span');
    overlayBgLabel.className = 'overlay-op-label';
    overlayBgLabel.textContent = I('背景透明度');
    els.overlayBgLabel = overlayBgLabel;
    els.overlayLine = mkRange();
    const overlayLineLabel = document.createElement('span');
    overlayLineLabel.className = 'overlay-op-label';
    overlayLineLabel.textContent = I('折线透明度');
    els.overlayLineLabel = overlayLineLabel;
    // 时间戳圆点开关（曲线基线上的琥珀色点，悬停显示说明）：与首行同款布局，独占一行
    els.overlayTsDots = document.createElement('input');
    els.overlayTsDots.type = 'checkbox';
    els.overlayTsDots.id = 'ytex-overlay-ts-dots';
    els.overlayTsDots.checked = true;
    const overlayTsWrap = document.createElement('div');
    overlayTsWrap.className = 'overlay-toggle-wrap';
    const overlayTsLabel = document.createElement('label');
    overlayTsLabel.htmlFor = 'ytex-overlay-ts-dots';
    overlayTsLabel.textContent = I('显示时间戳圆点');
    els.overlayTsLabel = overlayTsLabel;
    overlayTsWrap.append(els.overlayTsDots, overlayTsLabel);
    overlaySet.append(overlayToggleWrap, overlayTsWrap, overlayBgLabel, els.overlayBg, overlayLineLabel, els.overlayLine);
    // 聊天缓存清除（笑点曲线 Tab 底部）：清掉该视频已采集的聊天数据
    els.chartFoot = document.createElement('div');
    els.chartFoot.className = 'chart-foot';
    els.chatStartBtn = document.createElement('button');
    els.chatStartBtn.className = 'btn';
    els.chatStartBtn.textContent = I('▶ 开始采集');
    els.chatStartBtn.title = I('默认不采集聊天；点击后全量拉取回放弹幕并生成笑点曲线（可随时停止）');
    els.cacheBtn = document.createElement('button');
    els.cacheBtn.className = 'btn ghost';
    els.cacheBtn.textContent = I('清除本视频聊天缓存');
    els.cacheBtn.title = I('删除该视频已缓存的聊天数据，下次打开重新全量采集');
    els.chartFoot.append(els.chatStartBtn, els.cacheBtn);
    els.secChart.append(chartWrap, els.emotes, overlaySet, els.chartFoot);

    // Tab 3：笔记（时间戳编辑器）
    els.secNotes = document.createElement('div');
    els.secNotes.className = 'sec';
    els.secNotes.id = 'sec-notes';
    const notesToolbar = document.createElement('div');
    notesToolbar.className = 'notes-toolbar';
    els.noteTsBtn = document.createElement('button');
    els.noteTsBtn.className = 'btn';
    els.noteTsBtn.textContent = '⏱ 插入时间戳';
    els.noteTsBtn.title = '暂停视频并把当前时间戳插入光标处';
    els.noteSecBtn = document.createElement('button');
    els.noteSecBtn.className = 'btn ghost';
    els.noteSecBtn.textContent = '【节】';
    els.noteSecBtn.title = '插入大节标题，光标落在【】内';
    els.noteSubBtn = document.createElement('button');
    els.noteSubBtn.className = 'btn ghost';
    els.noteSubBtn.textContent = '└ 小节';
    els.noteSubBtn.title = '插入带缩进的小节行';
    els.noteMarkBtn = document.createElement('button');
    els.noteMarkBtn.className = 'btn ghost';
    els.noteMarkBtn.textContent = I('★ 重点');
    els.noteMarkBtn.title = '给选中（或当前）行切换重点标记（符号可在设置自定义）';
    els.noteIndentBtn = document.createElement('button');
    els.noteIndentBtn.className = 'btn ghost';
    els.noteIndentBtn.textContent = '⇥ 缩进';
    els.noteIndentBtn.title = '给选中（或当前）行增加一级缩进';
    els.noteOutdentBtn = document.createElement('button');
    els.noteOutdentBtn.className = 'btn ghost';
    els.noteOutdentBtn.textContent = '⇤ 减缩进';
    els.noteOutdentBtn.title = '给选中（或当前）行减少一级缩进';
    els.noteCopyBtn = document.createElement('button');
    els.noteCopyBtn.className = 'btn ghost';
    els.noteCopyBtn.textContent = '复制';
    els.noteCopyBtn.title = '复制全部内容到剪贴板';
    els.notePauseBtn = document.createElement('button');
    els.notePauseBtn.className = 'btn ghost';
    els.notePauseBtn.title = I('切换：插入时间戳时是否自动暂停视频');
    notesToolbar.append(els.noteTsBtn, els.notePauseBtn, els.noteSecBtn, els.noteSubBtn, els.noteMarkBtn, els.noteIndentBtn, els.noteOutdentBtn, els.noteCopyBtn);
    els.notesArea = document.createElement('textarea');
    els.notesArea.className = 'notes-area';
    els.notesArea.spellcheck = false;
    els.notesArea.placeholder = '点「⏱ 插入时间戳」记录当前位置，再加文字说明；内容按视频自动保存。';
    els.notesHint = document.createElement('div');
    els.notesHint.className = 'notes-hint';
    els.notesHint.textContent = '时间戳可点击跳转验证；行内 -1s/+1s 可微调时间；内容按视频自动保存。';
    els.notesPreview = document.createElement('div');
    els.notesPreview.className = 'notes-preview';
    els.secNotes.append(notesToolbar, els.notesArea, els.notesPreview, els.notesHint);

    // Tab 4：AI 总结
    els.secAI = document.createElement('div');
    els.secAI.className = 'sec';
    els.secAI.id = 'sec-ai';
    els.secAI.dataset.key = 'secAI';
    const aiCfg = document.createElement('div');
    aiCfg.className = 'setting-block';
    els.hAI = document.createElement('h4');
    els.hAI.textContent = 'AI 设置';
    const aiRow = (labelText, input) => {
      const r = document.createElement('div');
      r.className = 'ai-row';
      if (input.tagName === 'TEXTAREA') r.classList.add('ai-row-top');   // 多行输入：标签顶对齐
      const l = document.createElement('span');
      l.className = 'ai-label';
      l.textContent = labelText;
      r.append(l, input);
      return r;
    };
    els.aiUrl = document.createElement('input');
    els.aiUrl.className = 'ai-input';
    els.aiUrl.placeholder = 'https://api.openai.com/v1 / https://api.deepseek.com/v1 等（或用上方服务商预设）';
    els.aiKey = document.createElement('input');
    els.aiKey.className = 'ai-input';
    els.aiKey.type = 'password';
    els.aiKey.placeholder = 'sk-…';
    els.aiModel = document.createElement('input');
    els.aiModel.className = 'ai-input';
    els.aiModel.placeholder = 'gpt-4o-mini';
    els.aiOutLang = document.createElement('select');
    els.aiOutLang.className = 'bucket-sel';
    for (const [v, k] of [['auto', '自动（跟随界面）'], ['zh', '简体中文'], ['en', 'English'], ['ja', '日本語']]) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = k;
      els.aiOutLang.appendChild(opt);
    }
    // 直播类型：按类型切换总结侧重点（自动判断/杂谈/游戏/联动/歌回/其他）
    els.aiType = document.createElement('select');
    els.aiType.className = 'bucket-sel';
    els.aiTypeOptions = [['auto', '自动判断（默认）'], ['talk', '杂谈'], ['game', '游戏'], ['collab', '联动'], ['song', '歌回/音乐'], ['other', '其他']];
    for (const [v, k] of els.aiTypeOptions) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.dataset.i18n = k;
      opt.textContent = k;
      els.aiType.appendChild(opt);
    }
    // 自定义要求（可选）：原样拼进提示词
    els.aiExtra = document.createElement('textarea');
    els.aiExtra.className = 'ai-extra';
    els.aiExtra.placeholder = '可选。例如：重点总结技术细节／用轻松的语气／面向初学者解释术语…';
    // 术语数量上限（网络用语/专业术语最多列出几条；空或 0 = 不限）
    els.aiGlossMax = document.createElement('input');
    els.aiGlossMax.className = 'ai-input';
    els.aiGlossMax.type = 'number';
    els.aiGlossMax.min = '0';
    els.aiGlossMax.max = '200';
    els.aiGlossMax.placeholder = I('不限；填数字限制术语条数（如 10）');
    els.aiGlossMax.title = I('网络用语/专业术语最多列出的条数；留空或 0 表示不限制');
    // 服务商预设：选择后自动填入 API 地址与模型示例（标签即 i18n 键，语言切换时整体重译）
    els.aiPreset = document.createElement('select');
    els.aiPreset.className = 'bucket-sel';
    const aiPresets = [
      ['', '选择服务商（自动填入）', '', ''],
      ['openrouter', 'OpenRouter（多模型聚合，有免费档）', 'https://openrouter.ai/api/v1', 'qwen/qwen3.8-27b:free'],
      ['deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
      ['zhipu', '智谱 GLM（按量 API）', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.6'],
      ['qwen', '阿里通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
      ['moonshot', 'Moonshot Kimi', 'https://api.moonshot.cn/v1', 'moonshot-v1-8k'],
      ['gemini', 'Google Gemini（OpenAI 兼容）', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash'],
      ['groq', 'Groq（高速）', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
      ['siliconflow', '硅基流动（部分免费）', 'https://api.siliconflow.cn/v1', 'Qwen/Qwen2.5-7B-Instruct'],
      ['ollama', 'Ollama 本地', 'http://localhost:11434/v1', 'qwen2.5:7b'],
      ['anthropic', 'Anthropic Claude（官方）', 'https://api.anthropic.com/v1', 'claude-haiku-4-5'],
    ];
    els.aiPresetKeys = aiPresets;
    for (const [v, k] of aiPresets) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = I(k);
      els.aiPreset.appendChild(opt);
    }
    els.aiPreset.addEventListener('change', () => {
      const p = aiPresets.find(x => x[0] === els.aiPreset.value);
      if (p && p[0]) {
        els.aiUrl.value = p[2];
        els.aiModel.value = p[3];
        saveAiCfg();
        els.aiNote.textContent = `${I(p[1])}：${I('模型仅是示例，请换成你账号可用的模型名。Key 在服务商控制台获取。')}`;
      }
    });
    aiCfg.append(
      els.hAI,
      aiRow(I('服务商'), els.aiPreset),
      aiRow(I('API 地址'), els.aiUrl),
      aiRow(I('API Key'), els.aiKey),
      aiRow(I('模型'), els.aiModel),
      aiRow(I('输出语言'), els.aiOutLang),
      aiRow(I('直播类型'), els.aiType),
      aiRow(I('术语数量上限'), els.aiGlossMax),
      aiRow(I('自定义要求'), els.aiExtra),
    );
    const aiBtns = document.createElement('div');
    aiBtns.className = 'kw-btns';
    els.aiGenBtn = document.createElement('button');
    els.aiGenBtn.className = 'btn';
    els.aiGenBtn.textContent = I('生成总结');
    els.aiCopyBtn = document.createElement('button');
    els.aiCopyBtn.className = 'btn ghost';
    els.aiCopyBtn.textContent = I('复制');
    els.aiCopyBtn.disabled = true;
    els.aiCacheBtn = document.createElement('button');
    els.aiCacheBtn.className = 'btn ghost';
    els.aiCacheBtn.textContent = I('清除缓存');
    els.aiCacheBtn.title = I('删除本视频已保存的 AI 总结缓存（不影响已显示的内容）');
    aiBtns.append(els.aiGenBtn, els.aiCopyBtn, els.aiCacheBtn);
    els.aiOut = document.createElement('div');
    els.aiOut.className = 'ai-output';
    els.aiNote = document.createElement('div');
    els.aiNote.className = 'notes-hint';
    els.aiNote.style.padding = '0 12px 6px';
    els.aiNote.textContent = I('选择服务商可自动填入地址与模型示例；Key 在服务商控制台获取，仅保存在本地。支持 OpenAI 兼容协议的任意平台（含 Ollama/LM Studio 本地模型）。');
    // 字幕下载块：轨道下拉（含 ASR 自动字幕）+ SRT 下载；切视频时自动刷新。
    // 布局放最上面：字幕是 AI 总结的素材来源，先取字幕再看总结。
    const subsBlock = document.createElement('div');
    subsBlock.className = 'setting-block';
    els.hSubs = document.createElement('h4');
    els.hSubs.textContent = I('字幕下载');
    const subsRow = document.createElement('div');
    subsRow.className = 'subs-row';
    els.subsSel = document.createElement('select');
    els.subsSel.className = 'bucket-sel';
    els.subsBtn = document.createElement('button');
    els.subsBtn.className = 'btn ghost';
    els.subsBtn.textContent = I('下载 SRT');
    els.subsBtn.disabled = true;
    els.thumbBtn = document.createElement('button');
    els.thumbBtn.className = 'btn ghost';
    els.thumbBtn.textContent = I('下载封面');
    els.thumbBtn.title = I('下载该视频的封面图（优先最大分辨率，JPG）');
    subsRow.append(els.subsSel, els.subsBtn, els.thumbBtn);
    subsBlock.append(els.hSubs, subsRow);
    els.aiMeta = document.createElement('div');
    els.aiMeta.className = 'ai-meta';
    // 免责声明：AI 生成内容提示（常驻显示在总结输出下方）
    els.aiDisclaimer = document.createElement('div');
    els.aiDisclaimer.className = 'ai-meta';
    // 追问区：对话列表 + 输入框 + 发送按钮（基于已总结缓存继续提问）
    els.aiFollow = document.createElement('div');
    els.aiFollow.className = 'ai-follow';
    els.aiFollowList = document.createElement('div');
    els.aiFollowList.className = 'ai-follow-list';
    els.aiFollowList.textContent = I('总结生成后，可在此继续追问视频相关问题');
    const followRow = document.createElement('div');
    followRow.className = 'ai-row';
    els.aiFollowInput = document.createElement('input');
    els.aiFollowInput.className = 'ai-input';
    els.aiFollowInput.placeholder = I('基于总结追问，如：哪个时间段最精彩？');
    els.aiFollowBtn = document.createElement('button');
    els.aiFollowBtn.className = 'btn';
    els.aiFollowBtn.textContent = I('追问');
    els.aiFollowClear = document.createElement('button');
    els.aiFollowClear.className = 'btn ghost';
    els.aiFollowClear.textContent = I('清空对话');
    els.aiFollowClear.title = I('清空本视频的追问对话记录');
    followRow.append(els.aiFollowInput, els.aiFollowBtn, els.aiFollowClear);
    els.aiFollow.append(els.aiFollowList, followRow);
    els.secAI.append(subsBlock, aiCfg, aiBtns, els.aiNote, els.aiMeta, els.aiOut, els.aiFollow, els.aiDisclaimer);
    // Tab 3：设置
    els.secSettings = document.createElement('div');
    els.secSettings.className = 'sec';
    els.secSettings.id = 'sec-settings';

    const blockLang = document.createElement('div');
    blockLang.className = 'setting-block';
    els.hLang = document.createElement('h4');
    els.hLang.textContent = '语言';
    els.langSel = document.createElement('select');
    els.langSel.className = 'bucket-sel';
    for (const [v, k] of [['auto', '自动（跟随浏览器）'], ['zh', '简体中文'], ['en', 'English'], ['ja', '日本語']]) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.dataset.i18n = k;
      opt.textContent = k;
      els.langSel.appendChild(opt);
    }
    // 缓存管理：清除当前视频的聊天缓存（下次重新全量采集）
    blockLang.append(els.hLang, els.langSel);

    const blockTheme = document.createElement('div');
    blockTheme.className = 'setting-block';
    els.hTheme = document.createElement('h4');
    els.hTheme.textContent = '主题';
    els.seg = document.createElement('div');
    els.seg.className = 'seg';
    els.themeLight = document.createElement('button');
    els.themeLight.className = 'seg-btn';
    els.themeLight.textContent = '浅色';
    els.themeDark = document.createElement('button');
    els.themeDark.className = 'seg-btn';
    els.themeDark.textContent = '深色';
    els.seg.append(els.themeLight, els.themeDark);
    blockTheme.append(els.hTheme, els.seg);

    const blockMarker = document.createElement('div');
    blockMarker.className = 'setting-block';
    const hMarker = document.createElement('h4');
    els.hMarker = hMarker;
    hMarker.textContent = '笔记重点标记';
    const markerHint = document.createElement('div');
    els.markerHint = markerHint;
    markerHint.className = 'setting-line';
    markerHint.textContent = '输入自定义符号（如 ★ / 🔥 / ❗），用于笔记工具栏';
    els.markerInput = document.createElement('input');
    els.markerInput.className = 'marker-input';
    els.markerInput.maxLength = 8;
    els.markerInput.placeholder = '★';
    blockMarker.append(hMarker, els.markerInput, markerHint);

    const blockKw = document.createElement('div');
    blockKw.className = 'setting-block';
    const hKw = document.createElement('h4');
    els.hKw = hKw;
    hKw.textContent = I('发笑关键词（每行一个，与内置规则叠加）');
    const kwBuiltIn = document.createElement('div');
    kwBuiltIn.className = 'setting-line';
    kwBuiltIn.textContent = `${I('内置')}：${YTEX.keywords.builtInWords().join('、')}`;
    els.kwArea = document.createElement('textarea');
    els.kwArea.className = 'kw-area';
    els.kwArea.rows = 4;
    els.kwArea.placeholder = '例如：\n笑嘻了\n乐\n666';
    const kwBtns = document.createElement('div');
    kwBtns.className = 'kw-btns';
    els.kwSaveBtn = document.createElement('button');
    els.kwSaveBtn.className = 'btn';
    els.kwSaveBtn.textContent = '保存关键词';
    els.kwClearBtn = document.createElement('button');
    els.kwClearBtn.className = 'btn ghost';
    els.kwClearBtn.textContent = '清除表情标记';
    els.kwClearBtn.title = '清空所有手动标记的发笑表情';
    els.kwClearBtn.style.marginLeft = 'auto';   // 顶到按钮行右缘（与输入框右边框对齐）
    kwBtns.append(els.kwSaveBtn, els.kwClearBtn);
    // 手动标记的表情只读列表（默认可滚动，防止过长撑开面板）
    els.kwEmoteList = document.createElement('div');
    els.kwEmoteList.className = 'kw-emote-list';
    els.kwEmoteList.textContent = '（无——在「笑点曲线」下方点击表情按钮即可标记）';
    blockKw.append(hKw, kwBuiltIn, els.kwArea, kwBtns, els.kwEmoteList);

    // 面板区块：自由模式 / 锁定 / 透明度 / 背景模糊度
    const blockPanel = document.createElement('div');
    blockPanel.className = 'setting-block';
    els.hPanel = document.createElement('h4');
    els.hPanel.textContent = I('面板');
    els.freeModeToggle = document.createElement('input');
    els.freeModeToggle.type = 'checkbox';
    els.freeModeToggle.id = 'ytex-free-mode';
    const freeModeLabel = document.createElement('label');
    freeModeLabel.htmlFor = 'ytex-free-mode';
    freeModeLabel.textContent = I('自由模式（面板可任意放置）');
    freeModeLabel.title = I('解除右侧吸附：面板可拖动到画面任意位置，宽高自由调整');
    els.freeModeLabel = freeModeLabel;   // 语言切换重译用
    els.panelLockedToggle = document.createElement('input');
    els.panelLockedToggle.type = 'checkbox';
    els.panelLockedToggle.id = 'ytex-panel-locked';
    const panelLockLabel = document.createElement('label');
    panelLockLabel.htmlFor = 'ytex-panel-locked';
    panelLockLabel.textContent = I('锁定面板位置（防止误触拖动）');
    els.panelLockLabel = panelLockLabel;
    els.panelOpacityRange = document.createElement('input');
    els.panelOpacityRange.type = 'range';
    els.panelOpacityRange.min = '0.3';
    els.panelOpacityRange.max = '1';
    els.panelOpacityRange.step = '0.05';
    const panelOpacityLabel = document.createElement('span');
    panelOpacityLabel.className = 'overlay-op-label';
    panelOpacityLabel.textContent = I('面板透明度');
    els.panelBlurRange = document.createElement('input');
    els.panelBlurRange.type = 'range';
    els.panelBlurRange.min = '0';
    els.panelBlurRange.max = '30';
    els.panelBlurRange.step = '1';
    const panelBlurLabel = document.createElement('span');
    panelBlurLabel.className = 'overlay-op-label';
    panelBlurLabel.textContent = I('背景模糊度');
    els.panelOpacityLabel = panelOpacityLabel;   // 语言切换重译用
    els.panelBlurLabel = panelBlurLabel;
    els.panelResetBtn = document.createElement('button');
    els.panelResetBtn.className = 'btn ghost';
    els.panelResetBtn.textContent = I('重置面板位置和大小');
    els.panelResetBtn.title = I('恢复默认的右侧吸附布局');
    // 面板区块事件：变更即持久化并实时应用
    els.freeModeToggle.addEventListener('change', () => {
      freeMode = els.freeModeToggle.checked;
      try { chrome.storage.local.set({ ytexFreeMode: freeMode }); } catch {}
      applyFreeMode();   // 取消勾选仅回到吸附；位置保留在内存/存储，重新勾选时原位恢复
    });
    els.panelLockedToggle.addEventListener('change', () => {
      panelLocked = els.panelLockedToggle.checked;
      try { chrome.storage.local.set({ ytexPanelLocked: panelLocked }); } catch {}
      els.panel.classList.toggle('panel-locked', panelLocked);
    });
    els.panelOpacityRange.addEventListener('input', () => {
      panelOpacity = Number(els.panelOpacityRange.value);
      try { chrome.storage.local.set({ ytexPanelOpacity: panelOpacity }); } catch {}
      applyPanelOpacity();   // 只调节背景不透明度，文字不受影响
    });
    els.panelBlurRange.addEventListener('input', () => {
      panelBlur = Number(els.panelBlurRange.value);
      try { chrome.storage.local.set({ ytexPanelBlur: panelBlur }); } catch {}
      applyPanelBlur();
    });
    els.panelResetBtn.addEventListener('click', () => {
      freeMode = false;
      panelLocked = false;
      leftOffset = null;
      freeSize = null;
      topOffset = null;
      els.freeModeToggle.checked = false;
      els.panelLockedToggle.checked = false;
      try { chrome.storage.local.remove(['ytexFreeMode', 'ytexPanelLocked', 'ytexFreePos', 'ytexFreeSize']); } catch {}
      applyFreeMode();
      els.panel.style.opacity = String(panelOpacity);
      setStatus(I('面板已恢复默认布局'));
    });
    const panelRow1 = document.createElement('div');
    panelRow1.className = 'overlay-toggle-wrap';
    panelRow1.append(els.freeModeToggle, freeModeLabel);
    const panelRow2 = document.createElement('div');
    panelRow2.className = 'overlay-toggle-wrap';
    panelRow2.append(els.panelLockedToggle, panelLockLabel);
    const panelRow3 = document.createElement('div');
    panelRow3.className = 'overlay-set';
    panelRow3.append(panelOpacityLabel, els.panelOpacityRange, panelBlurLabel, els.panelBlurRange);
    // 重置按钮独占一行，与勾选行同款左对齐布局
    const panelResetWrap = document.createElement('div');
    panelResetWrap.className = 'overlay-toggle-wrap';
    panelResetWrap.style.marginTop = '8px';
    panelResetWrap.append(els.panelResetBtn);
    blockPanel.append(els.hPanel, panelRow1, panelRow2, panelRow3, panelResetWrap);

    els.secSettings.append(blockLang, blockTheme, blockMarker, blockPanel, blockKw);
    els.hAI.textContent = I('AI 设置');
    if (els.aiNote) els.aiNote.textContent = I('选择服务商可自动填入地址与模型示例；Key 在服务商控制台获取，仅保存在本地。支持 OpenAI 兼容协议的任意平台（含 Ollama/LM Studio 本地模型）。');
    els.aiGenBtn.textContent = I('生成总结');
    els.aiCopyBtn.textContent = I('复制');
    els.aiOutLang && [...els.aiOutLang.options].forEach((o, i) => {
      const keys = [I('自动（跟随界面）'), I('简体中文'), 'English', '日本語'];
      if (keys[i]) o.textContent = keys[i];
    });
    if (!aiRaw && !YTEX.ai.isGenerating()) {
      els.aiOut.textContent = I('填写上方配置后，点击「生成总结」——将综合字幕、评论区时间戳与聊天高能生成内容总结。');
    }

    const body = document.createElement('div');
    body.className = 'body';
    els.body = body;               // 面板滚动容器（时间戳列表自动跟随滚动它）
    body.append(els.secTimestamps, els.secChart, els.secNotes, els.secAI, els.secSettings);

    // 底部高度拖拽手柄：拖动调整面板高度（吸附/自由模式通用）
    els.htGrip = document.createElement('div');
    els.htGrip.id = 'ytex-ht-grip';
    els.htGrip.title = I('拖动调整面板高度');
    els.panel.appendChild(els.htGrip);
    els.htGrip.addEventListener('pointerdown', e => {
      if (panelLocked) return;
      e.preventDefault();
      els.htGrip.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = els.panel.getBoundingClientRect().height;
      const minH = 300;
      const maxH = window.innerHeight - 60;
      const onMove = ev => {
        const h = Math.min(Math.max(startH + (ev.clientY - startY), minH), maxH);
        els.panel.style.height = `${h}px`;
        if (freeMode) {
          freeSize = freeSize || {};
          freeSize.h = h;
        }
      };
      const onUp = () => {
        els.htGrip.removeEventListener('pointermove', onMove);
        els.htGrip.removeEventListener('pointerup', onUp);
        // 持久化高度：吸附模式 ytexDockedH；自由模式 ytexFreeSize.h
        try {
          const h = els.panel.getBoundingClientRect().height;
          if (freeMode) {
            freeSize = freeSize || {};
            freeSize.h = h;
            chrome.storage.local.set({ ytexFreeSize: freeSize });
          } else {
            chrome.storage.local.set({ ytexDockedH: h });
          }
        } catch {}
      };
      els.htGrip.addEventListener('pointermove', onMove);
      els.htGrip.addEventListener('pointerup', onUp);
    });

    els.footer = document.createElement('div');
    els.footer.className = 'footer';
    els.status = document.createElement('span');
    els.status.className = 'status';
    els.footer.append(els.status);

    els.panel.append(els.resize, els.header, body, els.footer);
    shadow.append(style, els.fab, els.panel);

    renderRows();
  }

  function open() {
    host.classList.add('open');
    if (topOffset !== null) els.panel.style.top = `${topOffset}px`;
    // 打开面板后立即定位到当前位置行（等一帧布局生效）
    requestAnimationFrame(() => followNearest(true));
  }

  function close() {
    host.classList.remove('open');
  }

  // 悬浮球显示/隐藏（持久化；悬停小 ×、右键球、工具栏图标三个入口共同走这里）
  function setFabHidden(v) {
    fabHidden = !!v;
    if (els.fab) els.fab.style.display = fabHidden ? 'none' : '';
    try {
      if (fabHidden) chrome.storage.local.set({ ytexFabHidden: true });
      else chrome.storage.local.remove(['ytexFabHidden']);
    } catch {}
  }

  // ---------- 对外 API ----------

  function setTimestamps(list) {
    if (!list || !list.length) {
      tsUnchecked.clear();   // 切视频清空勾选状态
      detailFocusReq = null; // 详情框定位请求一并作废
    }
    rows = [...list].sort((a, b) => a.time - b.time);
    renderRows();
  }

  YTEX.panel = {
    mount() {
      if (host) return;
      build();
      bindEvents();
      switchTab('timestamps');
      loadTheme();
      loadMarker();
      loadPauseOnInsert();
      loadAiCfg();
      loadOverlaySettings();
      loadPanelLayout();
      // 恢复吸附模式下的持久化高度
      try {
        chrome.storage.local.get(['ytexDockedH'], d => {
          if (d && typeof d.ytexDockedH === 'number' && d.ytexDockedH >= 300) {
            els.panel.style.height = `${d.ytexDockedH}px`;
          }
        });
      } catch {}
      // 恢复悬浮球隐藏状态
      try {
        chrome.storage.local.get(['ytexFabHidden'], d => {
          if (d && d.ytexFabHidden) setFabHidden(true);
        });
      } catch {}
      renderNotesPreview();
      (document.body || document.documentElement).appendChild(host);
      fitPanelWidthToTabs();   // 按启动语言（可能是日语等长标签语言）初始化面板宽度

      // 面板内的键盘事件不再冒泡到 YouTube：方向键/空格等不会触发播放器快捷键（快进快退、暂停等）。
      // Esc 收起面板的逻辑在拦截器内自行处理，不受影响。
      host.addEventListener('keydown', e => {
        if (e.key === 'Escape') close();
        e.stopPropagation();
      });
      host.addEventListener('keyup', e => e.stopPropagation());
      host.addEventListener('keypress', e => e.stopPropagation());
    },
    open,
    close,
    toggle: () => (host.classList.contains('open') ? close() : open()),
    onAction: () => {           // 工具栏图标点击：开合面板，悬浮球被移除时顺带恢复
      if (fabHidden) setFabHidden(false);
      if (host.classList.contains('open')) close();
      else open();
    },
    setTimestamps,
    setStatus,
    setChart,
    getChartData: () => chartData,       // 笑点曲线叠加层（视频进度条上方）取数用
    getTimestampRows: () => rows,        // 叠加层的时间戳圆点映射用
    loadNotes,
    loadAi,
    applyTexts,
    isOpen: () => !!host && host.classList.contains('open'),
  };
})();
