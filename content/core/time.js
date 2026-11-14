// 时间格式工具：时钟字符串 <-> 秒
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};

  // "1:02:03" / "02:03" → 秒；非法返回 null
  YTEX.clockToSeconds = clock => {
    const parts = String(clock).trim().split(':');
    if (parts.length > 3 || !parts.every(p => /^\d+$/.test(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
  };

  // URL 的 t 参数："83s" / "1m23s" / "1h2m3s" → 秒；非法返回 null
  YTEX.tParamToSeconds = t => {
    const m = /^(\d+h)?(\d+m)?(\d+s)?$/.exec(String(t).trim());
    if (!m) return null;
    const h = parseInt(m[1], 10) || 0;
    const mi = parseInt(m[2], 10) || 0;
    const s = parseInt(m[3], 10) || 0;
    return h * 3600 + mi * 60 + s;
  };

  // 纯文本时间戳正则（m:ss / h:mm:ss）工厂：每次返回全新实例，避免 /g 的 lastIndex 串扰
  YTEX.tsRegex = () => /\b(?:\d{1,2}:)?[0-5]?\d:[0-5]\d\b/g;
})();
