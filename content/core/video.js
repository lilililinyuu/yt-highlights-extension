// 视频定位与 seek：每次实时重查 video 元素（querySelector 开销极小）。
// 旧版缓存引用 + isConnected 校验在 SPA/广告场景会命中"仍在 DOM 但已被替换"的旧播放器，
// 导致点击时间戳后画面不动（跳转失效）。seek 统一入口：currentTime 赋值 + play 同步生效。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};

  YTEX.video = {
    invalidate() {},

    // 取当前 video 元素：候选依次为主播放器 video → #movie_player 内 video → 任意 video。
    // 前两个候选只会命中主播放器，兜底命中错误元素的概率极低。
    el() {
      return YTEX.q(YTEX.SELECTORS.video);
    },

    // 从 URL 解析视频 id，兼容 /watch?v= /shorts/ /live/
    videoId() {
      try {
        const u = new URL(location.href);
        if (u.pathname === '/watch') return u.searchParams.get('v');
        const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/);
        return m ? m[1] : null;
      } catch {
        return null;
      }
    },

    // 场景探测：live=正在直播（DVR 限制，扩展场景）、replay=点播/直播回放（主场景）
    scene() {
      const badge = YTEX.q(YTEX.SELECTORS.liveBadge);
      const isLive = !!badge && badge.offsetParent !== null;
      return isLive ? 'live' : 'replay';
    },

    duration() {
      const v = this.el();
      return v && isFinite(v.duration) ? v.duration : 0;
    },

    currentTime() {
      const v = this.el();
      return v ? v.currentTime : 0;
    },

    // 跳转到指定秒数，返回 clamp 后的实际秒数；无 video 时返回 null
    seekTo(sec, { play = true } = {}) {
      const v = this.el();
      if (!v) return null;
      let t = Number(sec);
      if (!isFinite(t)) return null;
      const dur = isFinite(v.duration) ? v.duration : 0;
      if (dur > 0) t = Math.max(0, Math.min(t, Math.max(0, dur - 0.3)));
      else t = Math.max(0, t);
      try {
        v.currentTime = t;
      } catch {
        return null;
      }
      if (play) v.play().catch(() => {}); // 自动播放策略拒绝时静默降级
      document.dispatchEvent(new CustomEvent('ytex:seek', { detail: { time: t } }));
      return t;
    },
  };
})();
