// DOM 适配层：集中管理所有选择器，YouTube 改版时只改这里。
// 每个条目是多候选选择器（新结构在前，旧结构兜底），按顺序取第一个命中。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};

  YTEX.SELECTORS = {
    video: ['video.html5-main-video', '#movie_player video', 'video'],
    player: ['#movie_player', '.html5-video-player'],
    progressBar: ['.ytp-progress-bar-container', '.ytp-progress-bar'],
    liveBadge: ['.ytp-live-badge'],
    commentsRoot: ['ytd-comments#comments', '#comments'],
    commentThread: ['ytd-comment-thread-renderer', 'ytd-comment-view-model'],
    // 评论区顶层的"继续加载"指示器（注意排除回复区的同名加载器）
    commentsContinuation: [
      'ytd-item-section-renderer > #contents > ytd-continuation-item-renderer',
      'ytd-comments ytd-continuation-item-renderer:not(ytd-comment-thread-renderer *)',
    ],
    commentAuthor: ['#author-text', 'a#author-text'],
    commentContent: ['#content-text', '#content'],
    commentLikes: ['#vote-count-middle'],
    chatItemsRoot: ['yt-live-chat-item-list-renderer #contents', '#chat #contents'],
    chatMessage: ['yt-live-chat-text-message-renderer'],
    chatMessageContent: ['#message'],
  };

  // 依次尝试多个候选选择器，返回第一个命中的元素
  YTEX.q = (names, root = document) => {
    for (const sel of names) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  // 同上，但返回命中的全部元素（ NodeList ）
  YTEX.qa = (names, root = document) => {
    for (const sel of names) {
      const els = root.querySelectorAll(sel);
      if (els.length) return els;
    }
    return [];
  };
})();
