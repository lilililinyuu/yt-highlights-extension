// 发笑判定规则（三层）：
// 1) 文本关键词：内置正则 + 设置页自定义词（storage）
// 2) 会员 emoji 手动标记：emojiId → 计入发笑（storage 持久化，跨频道通用）
// 3) 会员 emoji 名称模式：快捷名/无障碍标签命中即计入（零配置覆盖命名规范的频道）
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};

  // w 数量不限（1 个 w 到任意个 w、全半角ｗ 都算），但要求 w 前后都不是英文字母
  // （避免 shadow/hello 等英文单词内部的 w 误伤）
  const BASE_TEXT = /(哈哈|233+|草|(^|[^a-zA-Z])[wｗ]+(?![a-zA-Z])|\b(?:lol|lmao|rofl|kek)\b|(?:ha){2,}|(?:he){2,}|\bxd+\b|😂|🤣|笑死|笑)/im;
  const EMOTE_NAME = /(笑|草|lol|lmao|haha|ha{2,}|ww{2,}|233|nice|gg|emo|rofl|laugh|funny|smile|warai|kusa)/i;

  const state = { words: [], emotes: {}, loaded: false };

  YTEX.keywords = {
    // 启动时加载一次持久化规则
    init() {
      if (state.loaded) return;
      state.loaded = true;
      try {
        chrome.storage.local.get(['ytexLaughWords', 'ytexLaughEmotes'], d => {
          if (chrome.runtime.lastError || !d) return;
          if (Array.isArray(d.ytexLaughWords)) state.words = d.ytexLaughWords;
          if (d.ytexLaughEmotes && typeof d.ytexLaughEmotes === 'object') state.emotes = d.ytexLaughEmotes;
        });
      } catch {}
    },

    isLaughText(text) {
      if (!text) return false;
      if (BASE_TEXT.test(text)) return true;
      const low = String(text).toLowerCase();
      return state.words.some(w => w && low.includes(String(w).toLowerCase()));
    },

    // 自定义 emoji 判定：手动标记优先，其次名称模式（shortcuts 如 ":kddh_1:"，label 为无障碍描述）
    isLaughEmote(emojiId, names) {
      if (emojiId && state.emotes[emojiId]) return true;
      return (names || []).some(n => n && EMOTE_NAME.test(n));
    },

    isMarked(emojiId) {
      return !!(emojiId && state.emotes[emojiId]);
    },

    // 内置关键词展示（供设置页只读显示）
    builtInWords() {
      return ['哈哈', '233', '草', 'w / www / ｗ（独立 w）', 'lol / lmao / rofl / kek', 'haha / hehe', 'xd', '😂 / 🤣', '笑死', '笑'];
    },

    // 设置页接口：自定义关键词读写
    getCustomWords() {
      return [...state.words];
    },

    setCustomWords(arr) {
      state.words = (Array.isArray(arr) ? arr : []).map(s => String(s).trim()).filter(Boolean);
      try { chrome.storage.local.set({ ytexLaughWords: state.words }); } catch {}
    },

    emoteMarkCount() {
      return Object.keys(state.emotes).length;
    },

    // 手动标记的全部表情（含渲染信息；旧数据只存 true，则无 url/label）
    getEmoteMarks() {
      return Object.entries(state.emotes).map(([id, meta]) => ({
        id,
        url: meta && typeof meta === 'object' ? meta.url || '' : '',
        label: meta && typeof meta === 'object' ? meta.label || '' : '',
      }));
    },

    clearEmoteMarks() {
      state.emotes = {};
      try { chrome.storage.local.set({ ytexLaughEmotes: {} }); } catch {}
    },

    // 标记/取消某个 emoji 计入发笑，返回标记后的状态。
    // meta（url/label）一并保存，供设置区把 ID 渲染成表情图片。
    toggleEmote(emojiId, meta) {
      if (!emojiId) return false;
      if (state.emotes[emojiId]) delete state.emotes[emojiId];
      else state.emotes[emojiId] = meta && (meta.url || meta.label) ? { url: meta.url || '', label: meta.label || '' } : true;
      try { chrome.storage.local.set({ ytexLaughEmotes: state.emotes }); } catch {}
      return !!state.emotes[emojiId];
    },
  };
})();
