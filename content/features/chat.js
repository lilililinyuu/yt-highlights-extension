// 需求2：直播回放聊天笑点曲线（主场景）。
// 采集方式（唯一路径，yt-dlp 同款）：
//   聊天 iframe 的菜单 token（subMenuItems[1] 完整聊天流）→
//   POST live_chat/get_live_chat_replay 逐页翻取（毫秒级 videoOffsetTimeMsec）→ 全量曲线
// 判定：文本关键词 + 会员 emoji（手动标记优先、名称模式兜底）；原始消息常驻内存，标记切换即时重算。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};
  const I = (k, ...a) => YTEX.i18n.t(k, ...a);

  const MAX_CHAT_PAGES = 4000;     // 8h+ 长视频回放聊天可达近千页（每页约 30-60s），上限放宽到 4000
  let collecting = false;          // 正在翻页采集（供面板按钮态查询）
  let chatDone = false;            // 本视频已采集到片尾（供面板按钮态查询）
  let manualOn = false;            // 当前视频是否已手动开启采集（切视频复位）
  let curPageToken = null;         // 当前翻页位置 token（停止/刷新时落盘，供续采）
  let pagesThisRun = 0;            // 本次采集运行成功拉取的页数（续采失败判定用）

  // 消息去重 key（processMessage 与缓存恢复共用同一格式）
  const messageKey = (offsetSec, text, emotes) =>
    `${Math.round(offsetSec)}|${String(text).slice(0, 60)}|${(emotes || []).map(e => e.id).join(',')}`;
  const PAGE_DELAY_MS = 0;         // 链式请求不再人为限速（网络延迟本身即节流）
  const BUCKET_SEC_DEFAULT = 10;
  const RENDER_DEBOUNCE_MS = 400;
  const RETRY_ATTEMPTS = 2;        // 每页失败重试次数
  const RETRY_WAIT_MS = 1500;
  let gen = 0;
  let videoId = null;
  let rawMsgs = [];                // { offset(秒), text, emotes:[{id,nameHit,label}], textHit, laugh }
  let stats = { msg: 0, laugh: 0 };
  let renderTimer = 0;
  let seenMsgs = new Set();        // 去重（同时间窗同内容只计一次）
  let cachedMode = false;          // 命中会话缓存：即时出图，跳过网络采集
  let lastCacheSave = 0;
  let replayContToken = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getVideoId = () => videoId;

  // ---------- AI 素材：高能时段 + 每时段限量摘取留言 ----------
  const MATERIAL_PEAKS = 12;       // 最多摘取的高能时段数
  const SAMPLES_PER_PEAK = 5;      // 每个时段最多摘取的留言条数
  const MATERIAL_WIN_SEC = 60;     // 聚合窗口宽度

  // 留言过多时不全量读取：按 60s 窗口聚合，取发笑最多的前 N 个时段，
  // 每时段限量摘取代表性留言（优先发笑、其次实质内容，去重并截断长度）
  function getChatMaterial() {
    if (!rawMsgs.length) return { peaks: [], total: 0, laugh: 0 };
    const dur = YTEX.video.duration() || (rawMsgs[rawMsgs.length - 1].offset + MATERIAL_WIN_SEC) || 1;
    const buckets = new Map();
    for (const m of rawMsgs) {
      const b = Math.max(0, Math.floor(m.offset / MATERIAL_WIN_SEC));
      let arr = buckets.get(b);
      if (!arr) buckets.set(b, (arr = []));
      arr.push(m);
    }
    const scored = [...buckets.entries()]
      .map(([b, arr]) => ({
        start: b * MATERIAL_WIN_SEC,
        count: arr.length,
        laugh: arr.filter(m => m.laugh).length,
        arr,
      }))
      .sort((a, b) => (b.laugh - a.laugh) || (b.count - a.count))
      .slice(0, MATERIAL_PEAKS);
    // 输出按时间升序（素材阅读顺序）
    const peaks = scored
      .sort((a, b) => a.start - b.start)
      .map(({ start, laugh, arr }) => {
        const samples = [];
        const seen = new Set();
        const push = m => {
          const text = String(m.text || '').replace(/\s+/g, ' ').trim();
          if (!text || seen.has(text)) return;
          seen.add(text);
          samples.push(text.slice(0, 60) + (text.length > 60 ? '…' : ''));
        };
        arr.filter(m => m.laugh).forEach(push);
        for (const m of arr) {
          if (samples.length >= SAMPLES_PER_PEAK) break;
          if (m.text && m.text.length >= 8) push(m);
        }
        for (const m of arr) {
          if (samples.length >= SAMPLES_PER_PEAK) break;
          push(m);
        }
        return { start, laugh, count: arr.length, samples };
      });
    return { peaks, total: rawMsgs.length, laugh: rawMsgs.filter(m => m.laugh).length };
  }

  function clearChatStorage() {
    try { chrome.storage.local.remove([`ytexChat:${videoId}`]); } catch {}
  }

  // ---------- 分桶与统计 ----------

  function bucketSecFor(duration) {
    // 用户设置的固定桶宽优先（5–60s）；否则自适应：目标全片约 360 个点
    if (!(duration > 0)) return BUCKET_SEC_DEFAULT;
    const b = Math.max(5, Math.round(duration / 360 / 5) * 5);
    return Math.min(b, 60);
  }

  function rebuildBuckets(explicitB) {
    // 无源数据（已停止采集/缓存已清除）时保持上一次曲线，避免滚轮重建成全零折线
    if (!rawMsgs.length) {
      const prev = YTEX.panel && YTEX.panel.getChartData ? YTEX.panel.getChartData() : null;
      if (prev) return prev;
    }
    const dur = YTEX.video.duration()
      || (rawMsgs.length ? rawMsgs[rawMsgs.length - 1].offset + 30 : 0);
    if (!dur) return null;
    // 显示层可指定任意桶宽（Ctrl+滚轮缩放）；否则按设置/自适应
    const b = explicitB > 0 ? Math.min(Math.max(explicitB, 5), 300) : bucketSecFor(dur);
    const n = Math.max(1, Math.ceil(dur / b));
    const msg = new Array(n).fill(0);
    const laugh = new Array(n).fill(0);
    for (const m of rawMsgs) {
      let i = Math.floor(m.offset / b);
      if (i < 0) i = 0;
      if (i >= n) i = n - 1;
      msg[i]++;
      if (m.laugh) laugh[i]++;
    }
    return { laugh, msg, bucketSec: b, duration: dur };
  }

  function recomputeLaughs() {
    stats.laugh = 0;
    for (const m of rawMsgs) {
      m.laugh = m.textHit || m.emotes.some(e => e.nameHit || YTEX.keywords.isMarked(e.id));
      if (m.laugh) stats.laugh++;
    }
  }

  function flush() {
    if (renderTimer) return;
    const flushGen = gen;   // 捕获排入时的会话代号
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      // 缓存续采模式下也要实时重绘（新弹幕逐步入库，曲线随之增长）
      YTEX.panel.setChart(rebuildBuckets());
      setStatusChat('聊天采集中：{0} 条弹幕 · {1} 条发笑', stats.msg, stats.laugh);
      // 关键守卫：会话已切换（stop/切视频）不得写缓存；
      // chatDone 时更不能写——最后一页的防抖定时器会把刚写入的 done:1 打回 done:0
      // （这正是"显示采集完成、刷新后结果丢失"的根因）
      if (flushGen === gen && !chatDone) saveCacheSoon(false, curPageToken);
    }, RENDER_DEBOUNCE_MS);
  }

  function flushNow(statusText) {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
    // 缓存模式也要刷新图表：表情标记/取消后曲线需按新判定重绘
    YTEX.panel.setChart(rebuildBuckets());
    if (statusText) YTEX.panel.setStatus('chat', statusText);
    else setStatusChat('聊天快取完成：{0} 条弹幕 · {1} 条发笑', stats.msg, stats.laugh);
    if (!cachedMode) saveCacheSoon();   // 不传参：沿用 chatDone/curPageToken 当前状态
  }

  // ---------- 状态栏（chat 段）----------
  // 登记 key/args：语言切换后面板 applyTexts 回调 refreshStatus 重译当前状态

  let lastStatus = null;
  function setStatusChat(key, ...args) {
    lastStatus = { key, args };
    YTEX.panel.setStatus('chat', I(key, ...args));
  }
  function refreshStatus() {
    if (lastStatus) YTEX.panel.setStatus('chat', I(lastStatus.key, ...lastStatus.args));
  }

  // ---------- 会话缓存：同一视频第二次打开即时出图 ----------

  // 会话缓存（chrome.storage.local）：存原始弹幕 + 续页 token + 完成标记 + 表情图片 URL（u 字段）。
  // done=false 时下次打开可增量续采；命中后曲线/AI 聊天素材/表情统计全部可用
  // （回放聊天不可变，无过期问题）。
  function saveCacheSoon(done, token) {
    // 不显式传参时沿用当前会话状态：完成后任何 flush（表情切换/重绘）都保持 done=1，
    // 修复空参默认 false 把完整缓存降级回 done=0 的 bug
    if (done === undefined) done = chatDone;
    if (token === undefined) token = curPageToken;
    const now = Date.now();
    if (!videoId || now - lastCacheSave < 3000) return;
    saveCacheNow(done, token);
  }

  // 立即落盘（停止采集/翻页中断路径用，绕过 3s 节流）
  function saveCacheNow(done = false, token = null) {
    const now = Date.now();
    if (!videoId) return;
    lastCacheSave = now;
    if (!rawMsgs.length) return;
    try {
      const payload = {
        [`ytexChat:${videoId}`]: {
          at: now, done: done ? 1 : 0, token: token || '',
          raw: rawMsgs.map(m => ({
            o: Math.round(m.offset * 10) / 10,
            t: String(m.text || '').slice(0, 300),   // 弹幕快照单条截断，控制缓存体积
            e: m.emotes.map(e => [e.id, e.label || '', e.url || '']),
            th: m.textHit ? 1 : 0,
          })),
        },
      };
      try {
        chrome.storage.local.set(payload, () => {
          const err = chrome.runtime.lastError;
          if (!err) {
            return;
          }
          // 配额超限：按最后采集时间逐出最旧的聊天缓存后重试一次
          if (/quota/i.test(err.message)) {
            chrome.storage.local.get(null, all => {
              const chatKeys = Object.keys(all || {})
                .filter(k => k.startsWith('ytexChat:'))
                .sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
              const victims = chatKeys.filter(k => k !== `ytexChat:${videoId}`).slice(0, 3);
              if (!victims.length) {
                YTEX.panel.setStatus('chat', I('缓存写入失败：存储空间不足，且没有可清理的旧缓存'));
                return;
              }
              chrome.storage.local.remove(victims, () => {
                chrome.storage.local.set(payload, () => {
                  const err2 = chrome.runtime.lastError;
                  if (err2) {
                    YTEX.panel.setStatus('chat', I('缓存写入失败：存储空间不足（已在设置中清理空间后重试）'));
                  }
                });
              });
            });
          }
        });
      } catch {}
    } catch {}
  }

  // 静态读取某视频的聊天缓存（beginCollect 在 stop 前调用，videoId 尚未切换）
  function loadCacheFor(vid) {
    return new Promise(resolve => {
      if (!vid) return resolve(null);
      try {
        chrome.storage.local.get([`ytexChat:${vid}`], d => {
          if (chrome.runtime.lastError) return resolve(null);
          const entry = d && d[`ytexChat:${vid}`];
          if (!entry || !Array.isArray(entry.raw) || !entry.raw.length) return resolve(null);
          resolve({
            done: !!entry.done,
            token: entry.token || null,
            msgs: entry.raw.map(m => ({
              offset: m.o,
              text: m.t,
              emotes: (m.e || []).map(([id, label, url]) => ({ id, label: label || '', url: url || '', nameHit: false })),
              textHit: false,
              laugh: false,
            })),
          });
        });
      } catch { resolve(null); }
    });
  }

  function loadCache(myGen) {
    return new Promise(resolve => {
      if (!videoId) return resolve(null);
      try {
        chrome.storage.local.get([`ytexChat:${videoId}`], d => {
          if (chrome.runtime.lastError) return resolve(null);
          const entry = d && d[`ytexChat:${videoId}`];
          if (!entry || !Array.isArray(entry.raw)) return resolve(null);
          resolve({
            done: !!entry.done,
            token: entry.token || null,
            msgs: entry.raw.map(m => ({
              offset: m.o,
              text: m.t,
              emotes: (m.e || []).map(([id, label, url]) => ({ id, label: label || '', url: url || '', nameHit: false })),
              textHit: false,
              laugh: false,
            })),
          });
        });
      } catch { resolve(null); }
    });
  }

  // ---------- 消息解析 ----------

  function processMessage(offsetSec, runs) {
    let text = '';
    let laugh = false;
    const emotes = [];
    for (const run of runs || []) {
      if (run.text) { text += run.text; continue; }
      const em = run.emoji;
      if (!em) continue;
      const id = em.emojiId || '';
      const names = [...(em.shortcuts || []), em.image?.accessibility?.accessibilityData?.label || ''];
      const url = (em.image?.thumbnails || []).map(t => t.url).pop() || '';
      const nameHit = YTEX.keywords.isLaughEmote(id, names);
      // 无障碍名有时是图片地址——这类“名称”不能当显示文本，过滤掉
      const label = names.find(n => n && !/^(https?:)?\/\//.test(n)) || '';
      rememberEmote(id, url, label);   // 存入持久化目录：跨视频的手动标记也能解析出图片
      rememberShortcuts((em.shortcuts || []).filter(n => n && !/^(https?:)?\/\//.test(n)), url);
      emotes.push({ id, nameHit, label, url });
      if (nameHit) laugh = true;
    }
    const textHit = YTEX.keywords.isLaughText(text);
    if (textHit) laugh = true;

    // 去重：同时间窗同内容只计一次
    const key = messageKey(offsetSec, text, emotes);
    if (seenMsgs.has(key)) return;
    seenMsgs.add(key);

    rawMsgs.push({ offset: offsetSec, text, emotes, textHit, laugh });
    stats.msg++;
    if (laugh) stats.laugh++;
  }

  // 结构无关：深度收集响应里所有 replayChatItemAction 并入库，返回新增条数。
  // 兼容两种 item 变体：ytLiveChatTextMessageRenderer / liveChatTextMessageRenderer
  function ingestParsedChat(data) {
    let found = 0;
    const walk = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 30) return;
      if (Array.isArray(obj)) { for (const v of obj) walk(v, depth + 1); return; }
      const rep = obj.replayChatItemAction;
      if (rep) {
        const off = Number(rep.videoOffsetTimeMsec);
        if (Number.isFinite(off)) {
          for (const ia of rep.actions || []) {
            const item = ia?.addChatItemAction?.item || {};
            const msg = item.ytLiveChatTextMessageRenderer || item.liveChatTextMessageRenderer;
            if (msg) { processMessage(Math.max(0, off / 1000), msg.message?.runs); found++; }
          }
        }
      }
      for (const v of Object.values(obj)) walk(v, depth + 1);
    };
    walk(data, 0);
    return found;
  }

  // 解析一页回放聊天响应（continuationContents 结构），返回下一页 token
  function parseLiveChatPage(data) {
    const cont = data?.continuationContents?.liveChatContinuation;
    const actions = cont?.actions || [];
    for (const a of actions) {
      const rep = a?.replayChatItemAction;
      const offsetMsec = Number(rep?.videoOffsetTimeMsec);
      if (!Number.isFinite(offsetMsec)) continue;
      const inner = rep?.actions || (a?.addChatItemAction ? [a] : []);
      for (const ia of inner) {
        const msg = ia?.addChatItemAction?.item?.liveChatTextMessageRenderer
                 || ia?.addChatItemAction?.item?.ytLiveChatTextMessageRenderer;
        if (!msg) continue;
        processMessage(Math.max(0, offsetMsec / 1000), msg.message?.runs);
      }
    }
    let next = null;
    for (const c of cont?.continuations || []) {
      const t = c?.liveChatReplayContinuationData?.continuation
             || c?.liveChatContinuationData?.continuation
             || c?.invalidationContinuationData?.continuation
             || c?.reloadContinuationData?.continuation;
      if (t) { next = t; break; }
    }
    return next;
  }

  // ---------- 路径 A：token 全量快取（唯一采集路径） ----------

  async function fetchReplay(myGen) {
    // 最终防线：未手动开启时，任何路径（含未知触发）都不得采集
    if (!manualOn) {
      return;
    }
    collecting = true;
    pagesThisRun = 0;
    try {
      await fetchReplayInner(myGen);
    } finally {
      collecting = false;
    }
  }

  async function fetchReplayInner(myGen) {
    // token：iframe 菜单/地址（chatframe 转发）→ 桥读 ytInitialData → 内联脚本 → 页面 HTML → token 扫描
    let token = null;
    for (let i = 0; i < 4 && myGen === gen && !token; i++) {
      if (replayContToken) { token = replayContToken; break; }
      token = await YTEX.innertube.getLiveChatContinuation(getVideoId());
      if (!token && i < 3) {
        YTEX.panel.setStatus('chat', I('定位聊天回放…（第 {0}/4 次尝试）', i + 2));
        await sleep(1200);
      }
    }
    if (myGen !== gen) return;
    if (!token) throw new Error(I('无聊天回放数据（普通视频或主播未开启回放聊天）'));

    let pages = 0;
    let failStreak = 0;
    let lastErr = '';
    while (token && pages < MAX_CHAT_PAGES && myGen === gen) {
      let data = null;
      for (let attempt = 0; attempt < RETRY_ATTEMPTS && !data; attempt++) {
        try {
          if (attempt > 0) await sleep(RETRY_WAIT_MS);   // 失败后短暂等待重试一次
          data = await YTEX.innertube.replayChat(token);
          failStreak = 0;
        } catch (err) {
          failStreak++;
          lastErr = String(err.message || err);
        }
      }
      if (myGen !== gen) return;
      if (!data) break;   // 连续失败：链中断，保留已采集数据（缓存标未完成，下次续采）
      pages++;
      pagesThisRun++;
      curPageToken = token;
      ingestParsedChat(data);
      const next = parseLiveChatPage(data);
      token = next;
      curPageToken = token;
      flush();
      if (token && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
    }
    if (myGen !== gen) return;
    recomputeLaughs();
    // 链正常走完才标记缓存完整；中断则保留 token 供下次增量续采。
    // replayContToken 必须与结束状态同步：自然完=null（isCollecting 恢复 false，
    // 按钮切到"采集完成"）；中断=当前 token（保持"采集中"，等待自愈续采）。
    // 页数到上限视为完成（继续翻页只会拿回相同页面）。
    if (token && pages >= MAX_CHAT_PAGES) {
      token = null;
    }
    if (token) {
      replayContToken = token;
      saveCacheNow(false, token);
      const tail = `（第 ${pages + 1} 页起中断：${lastErr}，已保留进度）`;
      flushNow(I('聊天快取完成：{0} 条弹幕 · {1} 条发笑', stats.msg, stats.laugh) + tail);
      lastStatus = { key: '聊天快取完成：{0} 条弹幕 · {1} 条发笑', args: [stats.msg, stats.laugh] };
    } else {
      replayContToken = null;
      saveCacheNow(true, null);
      chatDone = true;
      flushNow(I('聊天快取完成：{0} 条弹幕 · {1} 条发笑', stats.msg, stats.laugh));
    }
  }

  // ---------- 生命周期 ----------

  // 切视频：仅登记当前视频并复位，不自动采集（防止长视频内存/流量开销），需手动开启
  function start(vid) {
    stop();
    manualOn = false;
    videoId = vid;
    YTEX.panel.setChart(null);
    setStatusChat('笑点曲线未开启——点击「▶ 开始采集」获取本视频弹幕曲线');
  }

  // 手动开启：加载缓存（命中即出图）或全量采集
  async function beginManual() {
    manualOn = true;
    await beginCollect(videoId);
  }

  function stopManual() {
    manualOn = false;
    stop();
    setStatusChat('已停止采集——再次点击「▶ 开始采集」可续采');
  }

  async function beginCollect(vid, opts = {}) {
    // 先读缓存再 stop()：stop 会以未完成快照覆盖缓存，必须先把完成态与 token 捞出来
    const preCache = opts.fresh ? null : await loadCacheFor(vid);
    stop();
    videoId = vid;
    const myGen = gen;
    YTEX.panel.setChart(null);
    if (!opts.fresh) YTEX.panel.setStatus('chat', I('定位聊天回放…'));

    const scene = YTEX.video.scene();
    if (scene === 'live') {
      YTEX.panel.setChart(null);
      setStatusChat('正在直播：实时曲线属扩展场景（M5），当前版本仅解析回放');
      return;
    }

    // 缓存命中：恢复原始弹幕 → 重算发笑 → 即时出图（表情标记/AI 素材也全部可用）。
    // 上次未采完（done=false）则从缓存 token 继续增量采集，新数据按 key 去重合并。
    // （续采失败后的强制重采走 fresh=true，跳过缓存分支）
    if (opts.fresh) {
      clearChatStorage();
      YTEX.panel.setStatus('chat', I('从头全量采集聊天回放…'));
    }
    const cached = opts.fresh ? null : preCache;
    if (myGen !== gen) return;
    if (cached) {
      cachedMode = !!cached.done;   // 完整缓存=只读模式；未完整=即将续采，按正常采集处理
      rawMsgs = cached.msgs;
      stats = { msg: rawMsgs.length, laugh: 0 };
      seenMsgs = new Set(rawMsgs.map(m => messageKey(m.offset, m.text, m.emotes)));
      recomputeLaughs();
      replayContToken = cached.done ? null : cached.token;   // 完整缓存无需续采标记
      YTEX.panel.setChart(rebuildBuckets());
      if (cached.done) {
        chatDone = true;   // stop() 不再清除完成态，按钮显示「✓ 采集完成」
        YTEX.panel.setStatus('chat', I('已从缓存即时加载聊天曲线', stats.msg, stats.laugh));
        return;
      }
      YTEX.panel.setStatus('chat', I('缓存未完整：继续增量采集…（已恢复 {0} 条）', stats.msg));
      await fetchReplay(myGen);
      if (myGen !== gen) return;
      if (pagesThisRun > 0 || chatDone) return;   // 续采有进展或已完成
      // 续采失败（token 失效等）：丢弃半截缓存，从头全量重采一次（不再递归重试）
      YTEX.panel.setStatus('chat', I('续采失败（缓存 token 已失效）——从头重新采集…'));
      clearChatStorage();
      await beginCollect(vid, { fresh: true });
      return;
    }

    try {
      await fetchReplay(myGen);
    } catch (err) {
      if (myGen !== gen) return;
      // 接口路径失败：不放弃——等待页面聊天数据加载（bridge 捕获后自动续全量快取）
      YTEX.panel.setChart(null);
      YTEX.panel.setStatus('chat', I('等待聊天数据加载…（展开右侧「实时聊天重放」面板可加速）'));
    }
  }

  function stop() {
    gen++;
    // 采集完成态：缓存已是 done=1，不能被未完成快照覆盖；完成标志保留（供"采集完成"显示）
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
    if (!chatDone) saveCacheNow(false, curPageToken);
    rawMsgs = [];
    seenMsgs = new Set();
    stats = { msg: 0, laugh: 0 };
    lastCacheSave = 0;
    replayContToken = null;
    curPageToken = null;
    lastFeedAt = 0;
  }

  // ---------- 供面板使用的接口 ----------

  // 表情目录（持久化）：id → {url,label}。手动标记跨视频保留，
  // 旧标记没有存图片信息，靠这目录在任意视频里解析出图片。
  const EMOTE_DIR_KEY = 'ytexEmoteDir';
  const emoteDir = new Map();
  let emoteDirLoaded = false;
  let emoteDirSaveTimer = 0;

  function loadEmoteDir() {
    if (emoteDirLoaded) return;
    emoteDirLoaded = true;
    try {
      chrome.storage.local.get([EMOTE_DIR_KEY], d => {
        if (chrome.runtime.lastError || !d || !d[EMOTE_DIR_KEY]) return;
        for (const [id, meta] of Object.entries(d[EMOTE_DIR_KEY] || {})) {
          if (meta && meta.url) emoteDir.set(id, meta);
        }
      });
    } catch {}
  }

  function scheduleSaveEmoteDir() {
    if (emoteDirSaveTimer) return;
    emoteDirSaveTimer = setTimeout(() => {
      emoteDirSaveTimer = 0;
      try {
        const entries = [...emoteDir.entries()].slice(-600);   // 上限 600 条，丢最早的
        chrome.storage.local.set({ [EMOTE_DIR_KEY]: Object.fromEntries(entries) });
      } catch {}
    }, 2000);
  }

  function rememberEmote(id, url, label) {
    if (!id || !url) return;
    const prev = emoteDir.get(id);
    if (prev) {
      if (label && !prev.label) { prev.label = label; scheduleSaveEmoteDir(); }
      return;
    }
    emoteDir.set(id, { url, label: label || '' });
    scheduleSaveEmoteDir();
  }

  loadEmoteDir();

  // 快捷名 → 图片地址目录（持久化）：评论正文里的 ":shortcut:" 渲染成表情图片
  const EMOTE_SC_KEY = 'ytexEmoteShortcuts';
  const scMap = new Map();
  let scLoaded = false;
  let scSaveTimer = 0;

  function loadScMap() {
    if (scLoaded) return;
    scLoaded = true;
    try {
      chrome.storage.local.get([EMOTE_SC_KEY], d => {
        if (chrome.runtime.lastError || !d || !d[EMOTE_SC_KEY]) return;
        for (const [k, v] of Object.entries(d[EMOTE_SC_KEY] || {})) {
          if (v) scMap.set(k, v);
        }
      });
    } catch {}
  }

  function rememberShortcuts(shortcuts, url) {
    if (!url || !shortcuts || !shortcuts.length) return;
    loadScMap();
    let changed = false;
    for (const sc of shortcuts) {
      if (sc && !scMap.has(sc)) { scMap.set(sc, url); changed = true; }
    }
    if (changed) {
      clearTimeout(scSaveTimer);
      scSaveTimer = setTimeout(() => {
        scSaveTimer = 0;
        try { chrome.storage.local.set({ [EMOTE_SC_KEY]: Object.fromEntries(scMap) }); } catch {}
      }, 2000);
    }
  }

  loadScMap();

  // 查询快捷名对应的表情图片（时间戳说明渲染用）
  function emoteUrlForShortcut(sc) {
    if (!sc) return '';
    const hit = scMap.get(sc);
    if (hit) return hit;
    // 评论正文与聊天目录的 label 可能存在宽度/大小写变体（如 ﾗﾌ vs ラブ）：
    // 未精确命中时按 NFKC 规范化再模糊匹配一遍
    const norm = String(sc).normalize('NFKC').toLowerCase();
    if (norm !== sc) {
      for (const [k, v] of scMap) {
        if (String(k).normalize('NFKC').toLowerCase() === norm) return v;
      }
    }
    return '';
  }

  // 查询表情目录（设置区渲染手动标记用）
  function emoteMeta(id) {
    return emoteDir.get(id) || null;
  }

  function emoteStats(topN = 0) {   // topN=0：返回全部出现过的表情
    const counts = new Map();
    const labels = new Map();
    const urls = new Map();
    for (const m of rawMsgs) {
      for (const e of m.emotes) {
        counts.set(e.id, (counts.get(e.id) || 0) + 1);
        if (e.label && !labels.has(e.id)) labels.set(e.id, e.label);
        if (e.url && !urls.has(e.id)) urls.set(e.id, e.url);
      }
    }
    let list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (topN > 0) list = list.slice(0, topN);
    return list
      .map(([id, count]) => ({ id, count, marked: YTEX.keywords.isMarked(id), label: labels.get(id) || '', url: urls.get(id) || '' }));
  }

  function toggleEmote(id, meta) {
    YTEX.keywords.toggleEmote(id, meta);
    recomputeLaughs();
    flushNow();
  }

  YTEX.chat = {
    start, stop, beginManual, stopManual, emoteStats, toggleEmote, emoteMeta, emoteUrlForShortcut,
    getChatMaterial,
    refreshStatus,   // 语言切换后重设状态栏（面板 applyTexts 回调）
    _ingest: ingestParsedChat,   // 供测试/调试注入
    isCollecting: () => collecting || !!renderTimer || !!replayContToken,
    isDone: () => chatDone,
    markNotDone: () => { chatDone = false; },
    refreshChart: () => flushNow(),
    // 按任意桶宽重算序列（显示层缩放用；width<=0 时自适应）
    getSeries: width => rebuildBuckets(width > 0 ? width : bucketSecFor(YTEX.video.duration() || 0)),
  };

  // ---------- 聊天数据事件接线 ----------

  let lastFeedAt = 0;

  // chatframe.js（聊天 iframe 内）转发：URL continuation + "完整聊天流"菜单 token
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.source !== 'ytex-chatframe' || !YTEX.panel || cachedMode || !videoId || !manualOn) return;   // 手动开启后才响应

    if (chatDone) return;   // 已采集到片尾：忽略后续 token 推送，防止重复采集

    if (d.menuToken && !replayContToken) {
      replayContToken = d.menuToken;
      const myGen = gen;
      fetchReplay(myGen);
    }

    if (d.token && !replayContToken) {
      replayContToken = d.token;
      const myGen = gen;
      (async () => {
        // live_chat_replay 页面参数：抓取该页面，解析内嵌首批弹幕 + 真正的 API 续页 token
        let apiToken = null;
        try {
          const res = await fetch(d.href, { credentials: 'same-origin' });
          const html = await res.text();
          const obj = YTEX.extractObjectFrom(html, html.indexOf('ytInitialData'));
          const cont = obj && obj.continuationContents && obj.continuationContents.liveChatContinuation;
          if (cont) {
            const n0 = ingestParsedChat(cont);
            for (const c of cont.continuations || []) {
              const t = c && c.liveChatReplayContinuationData && c.liveChatReplayContinuationData.continuation;
              if (t) { apiToken = t; break; }
            }
            flush();
          }
        } catch (err) {
          console.warn('[YTEX] 解析回放页失败:', err.message);
        }
        if (myGen !== gen) return;
        if (!apiToken) apiToken = d.token;
        replayContToken = apiToken;
        fetchReplay(myGen);
      })();
    }
  });

  // 桥接层捕获的页面聊天接口响应（新版页内回放面板自己的数据通道）
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.source !== 'ytex-bridge' || d.type !== 'chat-feed' || !d.feed) return;
    if (!YTEX.panel || cachedMode || !videoId || !manualOn) return;   // 手动开启后才捕获页面聊天数据
    if (d.feed.at === lastFeedAt) return;
    lastFeedAt = d.feed.at;
    try {
      const data = JSON.parse(d.feed.text);
      const found = ingestParsedChat(data);
      if (found) flush();
      if (chatDone) return;   // 已到片尾：不再续采
      if (!replayContToken) {
        const cont = YTEX.deepFind(data, 'liveChatReplayContinuationData');
        if (cont && cont.continuation) {
          replayContToken = cont.continuation;
          fetchReplay(gen);
        }
      }
    } catch {}
  });
})();
