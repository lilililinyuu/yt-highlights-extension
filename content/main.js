// 入口：模块装配 + YouTube SPA 生命周期。
// YouTube 切视频不刷新页面，监听 yt-navigate-finish / yt-page-data-updated，
// 并以低频轮询兜底（跨 world 拿不到事件 detail，事件仅作触发信号，videoId 以 URL 为准）。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};
  const S = YTEX;
  const I = (k, ...a) => YTEX.i18n.t(k, ...a);

  let booted = false;
  let currentVideoId;

  function onVideoChange() {
    const vid = S.video.videoId();
    if (vid === currentVideoId) return;

    // 切视频：停掉旧采集、清空列表（M3 起这里同时重置曲线数据）
    currentVideoId = vid;
    S.video.invalidate();   // SPA 切视频：播放器 video 元素会被替换，清除旧引用
    S.comments.stop();
    S.chat.stop();
    S.panel.setTimestamps([]);
    S.panel.loadNotes(vid);
    S.panel.loadAi(vid);

    if (vid) {
      S.panel.setStatus('chat-common', I('视频 {0} · {1}', vid, S.video.scene() === 'live' ? I('直播（扩展）') : I('回放/点播')));
      S.comments.start(vid);
      S.chat.start(vid);
    } else {
      S.panel.setStatus(I('非视频页'));
      S.panel.setChart(null);
    }
  }

  function boot() {
    if (booted) return;
    booted = true;
    try {
      console.info('[YTEX] v1.1.50 已加载（评论时间戳 + 笑点曲线 + 笔记编辑器 + AI 总结）');
      S.keywords.init();
      S.i18n.init();
      S.panel.mount();
      // 工具栏图标点击（background 转发）：开合面板 / 恢复被移除的悬浮球
      try {
        chrome.runtime.onMessage.addListener(msg => {
          if (msg && msg.type === 'ytexAction' && S.panel.onAction) S.panel.onAction();
        });
      } catch {}
      onVideoChange();
      YTEX.i18n.onLangChange = () => {
        try { S.panel.applyTexts(); } catch {}
      };

      window.addEventListener('yt-navigate-finish', onVideoChange);
      window.addEventListener('yt-page-data-updated', onVideoChange);
      setInterval(onVideoChange, 1500);
    } catch (err) {
      console.error('[YTEX] 启动失败:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
