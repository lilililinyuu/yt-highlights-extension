// Innertube 内部接口封装（全量拉取主路径）。
// 配置获取三层兜底：MAIN-world 桥 → 页面内联 ytcfg 脚本 → 公开 WEB 客户端常量。
// 在隔离世界内发起同源 fetch（自动携带 Cookie）。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};

  const CONFIG_TIMEOUT_MS = 3000;
  // YouTube 每个页面都公开内建的 WEB 客户端 key，仅作最后兜底
  const FALLBACK_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  const FALLBACK_VERSION = '2.20240900.00.00';

  // 从 fromIndex 起找第一个 '{'，平衡括号扫描到闭合后 JSON.parse（容忍字符串内的花括号/引号）
  function extractObjectFrom(text, fromIndex) {
    const start = text.indexOf('{', fromIndex);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  // 定位带引号的 "marker" 之后的 JSON 对象
  function extractJsonValue(text, marker) {
    const at = text.indexOf(`"${marker}"`);
    if (at < 0) return null;
    return extractObjectFrom(text, at);
  }

  // 供其他模块解析页面内嵌 JSON（如 live_chat_replay 页的 ytInitialData）
  const ANDROID_CONTEXT = {
    client: {
      clientName: 'ANDROID',
      clientVersion: '19.09.37',
      androidSdkVersion: 30,
      hl: 'zh-CN',
      gl: 'HK',
      userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
    },
  };

  YTEX.extractObjectFrom = extractObjectFrom;

  // 从页面内联 ytcfg 脚本直接提取配置（不依赖 MAIN world）
  function localYtcfg() {
    let apiKey, context, version;
    for (const s of document.querySelectorAll('script:not([src])')) {
      const text = s.textContent || '';
      if (!text.includes('INNERTUBE')) continue;
      apiKey = apiKey || (text.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
      context = context || extractJsonValue(text, 'INNERTUBE_CONTEXT');
      version = version || (text.match(/"clientVersion":"([^"]+)"/) || [])[1];
    }
    if (apiKey && context) return { apiKey, context };
    if (context) return { apiKey: FALLBACK_KEY, context };  // 上下文拿到了，key 用公开常量
    return null;
  }

  YTEX.innertube = {
    _cfg: null,
    _cfgPromise: null,

    // 通过 MAIN-world 桥向页面上下文索要 ytcfg
    _viaBridge() {
      return new Promise((resolve, reject) => {
        const onMsg = e => {
          const d = e.data;
          if (!d || d.source !== 'ytex-bridge' || d.type !== 'innertube-config') return;
          window.removeEventListener('message', onMsg);
          if (d.apiKey && d.context) resolve({ apiKey: d.apiKey, context: d.context });
          else reject(new Error('bridge 返回的 ytcfg 为空'));
        };
        window.addEventListener('message', onMsg);
        setTimeout(() => {
          window.removeEventListener('message', onMsg);
          reject(new Error('bridge 响应超时'));
        }, CONFIG_TIMEOUT_MS);
        window.postMessage({ source: 'ytex-content', type: 'get-innertube-config' }, '*');
      });
    },

    getConfig() {
      if (this._cfg) return Promise.resolve(this._cfg);
      if (this._cfgPromise) return this._cfgPromise;
      this._cfgPromise = this._viaBridge()
        .catch(err => {
          console.warn('[YTEX] bridge 获取 ytcfg 失败，改用页面内联脚本:', err.message);
          const local = localYtcfg();
          if (local) return local;
          console.warn('[YTEX] 页面内联配置未找到，使用公开 WEB 客户端常量兜底');
          return {
            apiKey: FALLBACK_KEY,
            context: { client: { clientName: 'WEB', clientVersion: FALLBACK_VERSION, hl: 'zh-CN', gl: 'US' } },
          };
        })
        .then(cfg => {
          this._cfg = cfg;
          return cfg;
        });
      return this._cfgPromise;
    },

    // 调用 /youtubei/v1/next；body 里放 videoId 或 continuation
    async next(body) {
      const cfg = await this.getConfig();
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(cfg.apiKey)}&prettyPrint=false`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: cfg.context, ...body }),
        }
      );
      if (!res.ok) throw new Error(`next HTTP ${res.status}`);
      return res.json();
    },

    // 聊天回放起点 token，按可靠性排序：
    // ① 任意 src 含 live_chat 的 iframe（存在即铁证，SPA 实时）
    // ② MAIN-world 桥读实时 window.ytInitialData
    // ③ 内联 ytInitialData 脚本（校验视频 id，防 SPA 串页）
    // ④ 重新 fetch 当前 watch 页 HTML，从服务端渲染的 ytInitialData 解析（与硬刷新等价）
    async getLiveChatContinuation(vid) {
      const viaIframe = this._lcViaIframe();
      const viaAttr = this._lcViaFrameAttr();
      const viaBridge = await this._lcViaBridge();
      const viaDom = this._lcViaDom(vid);
      const viaHtml = await this._lcViaHtml(vid);
      const viaScan = await this._lcViaScan(vid);
      try {
        const srcs = [...document.querySelectorAll('iframe')].map(i => i.src).filter(Boolean);
        const frame = document.querySelector('ytd-live-chat-frame');
      } catch {}
      return null;
    },

    // 聊天框架元素（ytd-live-chat-frame/#chat）自身或浅层子树的属性里可能带 continuation URL
    _lcViaFrameAttr() {
      try {
        const root = document.querySelector('ytd-live-chat-frame, #chat');
        if (!root) return null;
        const els = [root, ...root.querySelectorAll('*')];
        for (const el of els) {
          for (const attr of el.attributes || []) {
            const v = attr.value || '';
            if (!v.includes('continuation=')) continue;
            const abs = v.includes('http') ? v : 'https://www.youtube.com/' + v.replace(/^\/+/, '');
            const t = new URL(abs, location.origin).searchParams.get('continuation');
            if (t) return t;
          }
        }
      } catch {}
      return null;
    },

    _lcViaIframe() {
      try {
        for (const f of document.querySelectorAll('iframe')) {
          const src = f.src || '';
          if (!src.includes('live_chat')) continue;
          const u = new URL(src, location.origin);
          const t = u.searchParams.get('continuation');
          if (t) return t;
        }
      } catch {}
      return null;
    },

    // 重新拉取当前 watch 页 HTML（服务端渲染，等价硬刷新），从中解析 ytInitialData
    _lcCache: new Map(),   // videoId → token，会话内复用，避免重复拉整页 HTML
    async _lcViaHtml(vid) {
      if (!vid) return null;
      if (this._lcCache.has(vid)) return this._lcCache.get(vid);
      try {
        // 从 videoId 构造固定的 watch 页地址（与当前页硬刷新等价），不依赖可变 URL 输入
        const res = await fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(vid), { credentials: 'same-origin' });
        if (!res.ok) return null;
        const html = await res.text();
        if (vid && !html.includes(vid)) return null;
        let at = html.indexOf('ytInitialData');
        while (at >= 0) {
          const obj = extractObjectFrom(html, at);
          if (obj) {
            const conv = YTEX.deepFind(obj, 'liveChatRenderer');
            const token = conv ? (YTEX.deepFind(conv, 'continuationCommand') || {}).token : null;
            if (token) {
              this._lcCache.set(vid, token);
              return token;
            }
          }
          at = html.indexOf('ytInitialData', at + 1);
        }
      } catch {}
      return null;
    },

    _lcViaBridge() {
      return new Promise(resolve => {
        const onMsg = e => {
          const d = e.data;
          if (!d || d.source !== 'ytex-bridge' || d.type !== 'livechat-continuation') return;
          window.removeEventListener('message', onMsg);
          resolve(d.token || null);
        };
        window.addEventListener('message', onMsg);
        setTimeout(() => {
          window.removeEventListener('message', onMsg);
          resolve(null);
        }, CONFIG_TIMEOUT_MS);
        window.postMessage({ source: 'ytex-content', type: 'get-livechat-continuation' }, '*');
      });
    },

    _lcViaDom(vid) {
      try {
        for (const s of document.querySelectorAll('script:not([src])')) {
          const text = s.textContent || '';
          if (!text.includes('ytInitialData')) continue;
          if (vid && !text.includes(vid)) continue;
          // 内联写法为无引号的 var ytInitialData = {...}，遍历所有出现位置逐个尝试
          let at = text.indexOf('ytInitialData');
          while (at >= 0) {
            const obj = extractObjectFrom(text, at);
            if (obj) {
              const conv = YTEX.deepFind(obj, 'liveChatRenderer');
              const token = conv ? (YTEX.deepFind(conv, 'continuationCommand') || {}).token : null;
              if (token) return token;
            }
            at = text.indexOf('ytInitialData', at + 1);
          }
        }
      } catch {}
      return null;
    },

    // 结构无关的最后兜底：YouTube 改版导致 liveChatRenderer 节点找不到时，
    // 从 HTML 穷举候选 continuation token，逐个调 live_chat 并用响应形态验证
    // （真正的聊天回放页会返回 continuationContents.liveChatContinuation 且 actions 含 replayChatItemAction）
    _lcScanTried: new Set(),
    async _lcViaScan(vid) {
      if (!vid || this._lcScanTried.has(vid)) return null;
      this._lcScanTried.add(vid);
      try {
        // 从 videoId 构造固定的 watch 页地址（与当前页硬刷新等价），不依赖可变 URL 输入
        const res = await fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(vid), { credentials: 'same-origin' });
        if (!res.ok) return null;
        const html = await res.text();
        if (!html.includes('live_chat')) {
          return null;
        }
        const seen = new Set();
        const candidates = [];
        const re = /"token":"([A-Za-z0-9_%\-]+)"/g;
        let m;
        while ((m = re.exec(html)) && candidates.length < 8) {
          const t = m[1];
          if (t.length < 30 || seen.has(t)) continue;
          seen.add(t);
          candidates.push(t);
        }
        for (const t of candidates) {
          try {
            const data = await this.liveChat(t);
            const actions = data?.continuationContents?.liveChatContinuation?.actions || [];
            if (actions.some(a => a?.replayChatItemAction)) return t;
          } catch {}
          await new Promise(r => setTimeout(r, 200));
        }
      } catch {}
      return null;
    },

    // 轮询桥接层捕获的页面聊天接口响应（新版页内回放聊天）
    getChatFeed() {
      return new Promise(resolve => {
        const onMsg = e => {
          const d = e.data;
          if (!d || d.source !== 'ytex-bridge' || d.type !== 'chat-feed') return;
          window.removeEventListener('message', onMsg);
          resolve(d.feed || null);
        };
        window.addEventListener('message', onMsg);
        setTimeout(() => {
          window.removeEventListener('message', onMsg);
          resolve(null);
        }, 1500);
        window.postMessage({ source: 'ytex-content', type: 'get-chat-feed' }, '*');
      });
    },

    // 调用 /youtubei/v1/live_chat；先用页面 WEB 上下文，404 时自动改用 ANDROID 上下文重试
    // （部分回放通道对 WEB 客户端门控）；失败时保留响应体片段供诊断
    async liveChat(continuation) {
      const cfg = await this.getConfig();
      const contexts = [
        cfg.context,
        {
          client: {
            clientName: 'ANDROID',
            clientVersion: '19.09.37',
            androidSdkVersion: 30,
            hl: 'zh-CN',
            gl: 'HK',
            userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
          },
        },
      ];
      let lastInfo = '';
      for (const ctx of contexts) {
        const res = await fetch('https://www.youtube.com/youtubei/v1/live_chat?prettyPrint=false', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: ctx, continuation }),
        });
        const text = await res.text();
        if (res.ok) {
          try { return JSON.parse(text); } catch { throw new Error('live_chat 响应解析失败'); }
        }
        lastInfo = `HTTP ${res.status} ${text.slice(0, 200)}`;
        if (res.status !== 404) break;   // 非 404（限流/网络）换客户端也没意义
      }
      throw new Error(`live_chat ${lastInfo}`);
    },
    // 播放器数据（含字幕轨道列表）
    async player(videoId) {
      const cfg = await this.getConfig();
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: cfg.context, videoId }),
      });
      if (!res.ok) throw new Error(`player HTTP ${res.status}`);
      return res.json();
    },

    // 回放聊天分页（yt-dlp 同款逻辑）：
    // 端点优先 get_live_chat_replay（yt-dlp 对回放使用的专用端点），失败回退 live_chat；
    // WEB 上下文 404 时再试 ANDROID 上下文。成功的端点/上下文组合会被记住，后续分页直接复用。
    _replayCombo: null,
    async replayChat(continuation) {
      const cfg = await this.getConfig();
      const combos = [];
      if (this._replayCombo) combos.push(this._replayCombo);
      combos.push(
        { ep: 'live_chat/get_live_chat_replay', ctx: cfg.context },
        { ep: 'live_chat/get_live_chat_replay', ctx: ANDROID_CONTEXT },
        { ep: 'live_chat', ctx: cfg.context },
        { ep: 'live_chat', ctx: ANDROID_CONTEXT },
      );
      const tried = new Set();
      let lastInfo = '';
      for (const combo of combos) {
        const key = `${combo.ep}|${combo.ctx === cfg.context ? 'web' : 'android'}`;
        if (tried.has(key)) continue;
        tried.add(key);
        let res;
        try {
          res = await fetch(`https://www.youtube.com/youtubei/v1/${combo.ep}?prettyPrint=false`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: combo.ctx, continuation }),
            // 聊天接口校验请求来源：模拟聊天重放 iframe 页面发起的请求
            referrer: `https://www.youtube.com/live_chat_replay?continuation=${encodeURIComponent(continuation)}`,
            referrerPolicy: 'strict-origin-when-cross-origin',
            signal: AbortSignal.timeout(20000),   // 防止请求无限挂起
          });
        } catch (err) {
          lastInfo = `${combo.ep} 网络错误（${err.name || err.message}）`;
          continue;   // 网络/超时错误 → 尝试下一个组合
        }
        const text = await res.text();
        if (res.ok) {
          try {
            const data = JSON.parse(text);
            this._replayCombo = combo;
            return data;
          } catch {
            lastInfo = '响应解析失败';
            continue;
          }
        }
        lastInfo = `${combo.ep} HTTP ${res.status} ${text.slice(0, 120)}`;
        if (res.status !== 404) break;   // 非 404（限流等）换组合无意义
      }
      throw new Error(lastInfo || 'replay_chat 全部组合失败');
    },
  };

  // 深度查找对象树中第一个指定键的值（接口响应结构多变，按键名取比按路径取稳）
  YTEX.deepFind = (obj, key, maxDepth = 12) => {
    if (!obj || typeof obj !== 'object' || maxDepth < 0) return null;
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
      const r = YTEX.deepFind(v, key, maxDepth - 1);
      if (r !== null && r !== undefined) return r;
    }
    return null;
  };
})();
