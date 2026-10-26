// MAIN world 桥：
// ① 把页面上下文的 ytcfg（Innertube API Key / context）转交给隔离世界
// ② 转发 ytInitialData 中聊天重放的起点 token
// ③ 强制 shadow DOM open（新版页内组件将内容渲染在 closed shadow root 时内容脚本无法读取）
(() => {
  // —— ③ 强制 shadow DOM open：必须在页面脚本运行前打补丁（本脚本 document_start 注入）
  try {
    if (!window.__ytexShadowPatched) {
      window.__ytexShadowPatched = true;
      const origAttachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        return origAttachShadow.call(this, { ...init, mode: 'open' });
      };
    }
  } catch {}

  function readCfg() {
    try {
      const get = k => (window.ytcfg && typeof window.ytcfg.get === 'function') ? window.ytcfg.get(k) : undefined;
      return { apiKey: get('INNERTUBE_API_KEY'), context: get('INNERTUBE_CONTEXT') };
    } catch {
      return { apiKey: undefined, context: undefined };
    }
  }

  // 在 ytInitialData 里找 liveChatRenderer → continuationCommand.token（聊天重放起点）
  function deepFindLiveChatToken(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 24) return null;
    if (obj.liveChatRenderer) {
      const c = obj.liveChatRenderer.continuation;
      for (const item of (Array.isArray(c) ? c : [c])) {
        const t = item && item.continuationCommand && item.continuationCommand.token;
        if (t) return t;
      }
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const r = deepFindLiveChatToken(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // 从播放器响应提取字幕轨道（紧凑结构转发给隔离世界）
  function extractCaptions(j) {
    try {
      const rs = j && j.captions && j.captions.playerCaptionsTracklistRenderer;
      const ts = (rs && rs.captionTracks) || [];
      if (!ts.length) return null;
      return {
        videoId: (j.videoDetails && j.videoDetails.videoId) || '',
        title: (j.videoDetails && j.videoDetails.title) || '',
        author: (j.videoDetails && j.videoDetails.author) || '',
        tracks: ts.map(t => ({
          baseUrl: t.baseUrl,
          languageCode: t.languageCode || '',
          kind: t.kind || '',
          name: (t.name && (t.name.simpleText || ((t.name.runs || []).map(r => r.text).join('')))) || t.languageCode || '',
        })),
      };
    } catch { return null; }
  }

  // ===== 捕获页面自身的聊天接口响应 =====
  // 新版页内回放聊天面板（无 iframe、数据不在 ytInitialData）通过页面自己的
  // fetch/XHR 请求聊天数据；此处挂钩并主动转发给隔离世界入库。
  // 同时顺带捕获 /player 响应里的字幕轨道（页面真实客户端数据，未受 PO Token 降级影响）。
  try {
    if (!window.__ytexFeedHooked) {
      window.__ytexFeedHooked = true;
      const capture = (url, text) => {
        try {
          if (text && (text.includes('replayChatItemAction') || text.includes('liveChatContinuation'))) {
            window.postMessage({
              source: 'ytex-bridge', type: 'chat-feed',
              feed: { url: String(url), text: text.slice(0, 2000000), at: Date.now() },
            }, '*');
          }
          // 页面自己的 /player 响应：广播字幕轨道（隔离世界直接调 API 可能被 PO Token 降级）
          if (text && url.includes('/youtubei/v1/player') && text.includes('"captionTracks"')) {
            const data = extractCaptions(JSON.parse(text));
            if (data) window.postMessage({ source: 'ytex-bridge', type: 'player-captions', ...data }, '*');
          }
          // 播放器加载的 timedtext 字幕正文（开启 CC 后必然产生）：缓存给下载功能直接使用。
          // 同时转发完整 URL——其中带播放器生成的 PO Token（pot），是 timedtext 接口
          // 不返回空正文的关键参数（实测无 pot 一律 200 空正文）。
          if (text && url.includes('/api/timedtext')) {
            try {
              const u = new URL(String(url), location.origin);
              const vid = u.searchParams.get('v') || '';
              const body = text.slice(0, 8000000);   // 8h+ 视频的 json3 字幕可达数 MB，截断会导致下载不完整
              if (vid && (body.trim() || u.searchParams.get('pot'))) {
                window.postMessage({
                  source: 'ytex-bridge', type: 'ttext',
                  videoId: vid,
                  lang: u.searchParams.get('lang') || '',
                  kind: u.searchParams.get('kind') || '',
                  body,
                  url: String(url),
                }, '*');
              } else {
              }
            } catch (e) {
              console.warn('[YTEX][bridge] timedtext 解析失败:', e);
            }
          }
        } catch {}
      };
      const origFetch = window.fetch;
      window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
          const a0 = args[0];
          const u = typeof a0 === 'string' ? a0 : (a0 && (a0.url || a0.href)) || '';
          if (u.includes('/youtubei/') || u.includes('/api/timedtext')) res.clone().text().then(t => capture(u, t)).catch(() => {});
        } catch {}
        return res;
      };
      const XHR = window.XMLHttpRequest;
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url, ...rest) {
        this.__ytexUrl = String(url || '');
        return origOpen.call(this, method, url, ...rest);
      };
      XHR.prototype.send = function (...args) {
        if (this.__ytexUrl && (this.__ytexUrl.includes('/youtubei/') || this.__ytexUrl.includes('/api/timedtext'))) {
          this.addEventListener('load', function () {
            try {
              // responseType 可能是 json/arraybuffer：responseText 只在 text 模式可用
              let text = '';
              if (this.responseType === '' || this.responseType === 'text') text = this.responseText || '';
              else if (typeof this.response === 'string') text = this.response;
              capture(this.__ytexUrl, text);
            } catch {}
          });
        }
        return origSend.apply(this, args);
      };
    }
  } catch {}

  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.source !== 'ytex-content') return;

    if (d.type === 'get-innertube-config') {
      const respond = () => {
        const cfg = readCfg();
        window.postMessage({ source: 'ytex-bridge', type: 'innertube-config', ...cfg }, '*');
      };
      respond();
      const retry = setTimeout(respond, 1500); // 页面脚本未就绪时补一次
      setTimeout(() => clearTimeout(retry), 2000);
      return;
    }

    if (d.type === 'get-livechat-continuation') {
      let token = null;
      try {
        token = deepFindLiveChatToken(window.ytInitialData);
        if (!token) {
        }
      } catch (err) {
        console.warn('[YTEX] bridge 读取 ytInitialData 异常:', err);
      }
      // SPA 导航时 window.ytInitialData 由页面脚本实时重赋值，始终对应当前视频
      window.postMessage({ source: 'ytex-bridge', type: 'livechat-continuation', token }, '*');
    }

    // 字幕轨道：读页面当前的 ytInitialPlayerResponse（真实浏览器客户端拿到的完整数据，
    // 不受隔离世界直连 API 的 PO Token 降级影响；SPA 导航时由页面脚本实时重赋值）
    if (d.type === 'get-captions') {
      let data = null;
      try {
        const pr = window.ytInitialPlayerResponse;
        data = extractCaptions(pr);
        if (data && !data.videoId && d.videoId) data.videoId = d.videoId;
      } catch (err) {
        console.warn('[YTEX] bridge 读取 ytInitialPlayerResponse 异常:', err);
      }
      window.postMessage({ source: 'ytex-bridge', type: 'captions', videoId: d.videoId, data }, '*');
    }
  });
})();
