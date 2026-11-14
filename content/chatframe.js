// 运行在聊天 iframe（live_chat_replay）内：
// 向父页面转发回放 continuation（地址参数）与"完整聊天流"菜单 token
// （ytInitialData → liveChatHeaderRenderer.sortFilterSubMenuRenderer.subMenuItems[1]，
//   即未过滤的完整数据流，yt-dlp 同款取法）。父页面据此走接口全量快取。
(() => {
  if (window.top === window) return;
  if (window.__ytexChatFrameHooked) return;
  window.__ytexChatFrameHooked = true;

  // 深度查找（本文件独立实现，隔离世界无 YTEX）
  function deepFind(obj, key, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 24) return null;
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
      const r = deepFind(v, key, depth + 1);
      if (r !== null && r !== undefined) return r;
    }
    return null;
  }

  // 平衡括号扫描：从 from 起找第一个 '{' 并解析 JSON 对象
  function extractBalanced(text, from) {
    const start = text.indexOf('{', from);
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
        if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
      }
    }
    return null;
  }

  // yt-dlp 同款：subMenuItems[1] 的 continuation 是"完整聊天流"起点。
  // 注意：可能是字符串，也可能是 {reloadContinuationData:{continuation:"…"}} 对象，需解包
  let menuTokenCache = null;
  function extractMenuToken() {
    if (menuTokenCache) return menuTokenCache;
    try {
      for (const s of document.querySelectorAll('script:not([src])')) {
        const text = s.textContent || '';
        let at = text.indexOf('ytInitialData');
        while (at >= 0) {
          const obj = extractBalanced(text, at);
          if (obj) {
            const sub = deepFind(obj, 'sortFilterSubMenuRenderer');
            const items = sub?.subMenuItems || [];
            let raw = (items[1] || items[0])?.continuation;
            if (raw && typeof raw === 'object') raw = deepFind(raw, 'continuation');
            if (typeof raw === 'string' && raw) { menuTokenCache = raw; return raw; }
          }
          at = text.indexOf('ytInitialData', at + 1);
        }
      }
    } catch {}
    return null;
  }

  function relay() {
    let token = null;
    try {
      token = new URLSearchParams(location.search).get('continuation');
      if (token && token.includes('%')) token = decodeURIComponent(token);   // 兼容双重编码
    } catch {}
    const menuToken = extractMenuToken();
    if (token || menuToken) {
      try {
        window.parent.postMessage({ source: 'ytex-chatframe', token, menuToken }, '*');
        return true;
      } catch {}
    }
    return false;
  }

  relay();
  setInterval(relay, 3000);   // 防早到：父页面/页面就绪前重复转发
})();
