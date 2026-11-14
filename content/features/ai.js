// AI 总结：聚合字幕 + 评论区时间戳 + 聊天高能反应，调用用户自定义的大模型
// （支持 OpenAI 兼容协议与 Anthropic 协议，API Key 本地保存）生成
// 「内容总结 + 分时间段说明 + 网络用语/专业术语解释」，输出语言可自定义。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};
  const I = (k, ...a) => YTEX.i18n.t(k, ...a);

  const DEFAULT_URL = 'https://api.openai.com/v1';
  const DEFAULT_MODEL = 'gpt-4o-mini';
  const SUB_MAX_CHARS = 48000;   // 长视频（8h+）字幕全量喂入，避免时间段只覆盖前半部分

  let generating = false;

  const fmt = sec => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
  };

  function loadCfg() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(['ytexAiUrl', 'ytexAiKey', 'ytexAiModel', 'ytexAiOutLang', 'ytexAiExtra'], d => {
          resolve({
            url: (d && d.ytexAiUrl) || DEFAULT_URL,
            key: (d && d.ytexAiKey) || '',
            model: (d && d.ytexAiModel) || DEFAULT_MODEL,
            outLang: (d && d.ytexAiOutLang) || 'auto',
            type: (d && d.ytexAiType) || 'auto',
            glossaryMax: Number.isFinite(Number(d && d.ytexAiGlossaryMax)) ? Number(d.ytexAiGlossaryMax) : 0,
            extra: (d && d.ytexAiExtra) || '',
          });
        });
      } catch {
        resolve({ url: DEFAULT_URL, key: '', model: DEFAULT_MODEL, outLang: 'auto', extra: '', type: 'auto', glossaryMax: 0 });
      }
    });
  }

  function outLanguage(outLang) {
    if (outLang === 'zh') return '简体中文';
    if (outLang === 'en') return 'English';
    if (outLang === 'ja') return '日本語';
    return YTEX.i18n.lang === 'ja' ? '日本語' : YTEX.i18n.lang === 'en' ? 'English' : '简体中文';
  }

  // 字幕：优先人工字幕，其次自动生成（ASR），按 ~45 秒块聚合。
  // 下载走 YTEX.subs.fetchSrt 的多源回退链（页面缓存正文 → 备用轨道轮替），
  // 规避直连 timedtext 的 PO Token 空响应问题；拿到 SRT 后就地解析成时间块。
  async function fetchSubtitles(videoId, maxChars) {
    let srt = '';
    let title = '';
    let author = '';
    try {
      const info = await YTEX.subs.listTracks(videoId);
      title = info.title || '';
      author = info.author || '';
      const tracks = info.tracks || [];
      const track = tracks.find(t => !t.asr) || tracks.find(t => t.asr) || null;
      if (track) srt = await YTEX.subs.fetchSrt(track, videoId);
    } catch {}
    if (!srt) return { subs: '', title, author, cues: [] };
    const cues = parseSrtCues(srt);
    const blocks = [];
    let cur = -1;
    let curText = '';
    for (const c of cues) {
      const t = Math.round(c.start);
      if (cur < 0 || t - cur >= 45) {
        if (curText) blocks.push({ t: cur, text: curText.trim() });
        cur = t;
        curText = c.text;
      } else {
        curText += ' ' + c.text;
      }
    }
    if (curText) blocks.push({ t: cur, text: curText.trim() });
    let out = '';
    for (const b of blocks) {
      const line = `${fmt(b.t)} ${b.text}\n`;
      if (out.length + line.length > maxChars) break;
      out += line;
    }
    return { subs: out, title, author, cues };
  }

  // SRT → [{start,end,text}]（秒）；追问按时间窗提取字幕原文时复用
  function parseSrtCues(srt) {
    const tc = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;
    const cues = [];
    for (const block of String(srt).replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n');
      const mi = lines.findIndex(l => tc.test(l));
      if (mi < 0) continue;
      const m = lines[mi].match(tc);
      const text = lines.slice(mi + 1).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      cues.push({
        start: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
        end: Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000,
        text,
      });
    }
    return cues;
  }

  async function gatherMaterial() {
    const vid = YTEX.video.videoId();
    const dur = YTEX.video.duration();
    let subs = '';
    let title = '';
    let author = '';
    try {
      const sub = await fetchSubtitles(vid, SUB_MAX_CHARS);
      subs = sub.subs || '';
      title = sub.title || '';
      author = sub.author || '';
    } catch (err) {
      console.warn('[YTEX] 字幕获取失败:', err);
    }
    if (!title) {
      try { title = document.title.replace(/\s*[-–—]\s*YouTube\s*$/i, '').trim(); } catch {}
    }
    const ts = (YTEX.comments.getTimestamps?.() || []).slice(0, 60)
      .map(r => `${fmt(r.time)} ${String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`)
      .join('\n').slice(0, 4000);
    const chat = YTEX.chat.getChatMaterial?.() || { peaks: [], total: 0, laugh: 0 };
    const chatText = chat.peaks
      .map(p => `${fmt(p.start)}（发笑 ${p.laugh}）：${p.samples.join(' / ')}`)
      .join('\n').slice(0, 4000);
    return { dur, subs, ts, chatText, chat, title, author };
  }

  // 按输出语言给出整套提示词模板。结构标题直接用目标语言给出（模型照抄即不会混语言），
  // 并附加"禁止混入其他语言"的强约束——修复此前中文标题混进日/英输出的 bug。
  const PROMPT_TEMPLATES = {
    '简体中文': {
      role: '你是专业的视频内容分析助手。下面是一个 YouTube 直播回放的三类材料：',
      info: m => `【视频信息】\n标题：${m.title || '（无）'}\n频道：${m.author || '（无）'}`,
      subs: '【字幕（按时间）】',
      ts: '【评论区时间戳与说明】',
      chat: '【聊天高能时段（含样本弹幕）】',
      none: '（无）',
      dur: d => `视频总时长：${fmt(d)}`,
      out: '请输出以下三部分：',
      items: [
        '1. 视频内容总结（3-5 段）',
        '2. 按内容划分的时间段：每段一行，格式「时间 标题：一句话说明」，按顺序覆盖全片',
        m => `3. 网络用语/专业术语说明：列出材料中出现的网络用语、行话、专有名词并逐一解释${m ? `（最多 ${m} 条，按重要程度选取）` : ''}`,
      ],
      req: '要求：时间格式用 M:SS 或 H:MM:SS；只使用材料中出现的信息，不要编造；时间段的划分必须覆盖全片直到结尾，不得中途省略或合并超长区段；若输出篇幅实在受限，可压缩文字说明的篇幅，但时间段条目必须一条不少地覆盖全篇。',
      strict: '输出的全部内容（包括各级标题）必须使用简体中文；引用原文与专有名词除外，禁止混入其他语言。',
      extraHead: '【用户自定义要求】（在不与上述格式要求冲突的前提下尽量满足）',
    },
    '日本語': {
      role: 'あなたはプロの動画コンテンツ分析アシスタントです。以下は YouTube アーカイブ配信の 3 種類の資料です：',
      info: m => `【動画情報】\nタイトル：${m.title || '（なし）'}\nチャンネル：${m.author || '（なし）'}`,
      subs: '【字幕（時間順）】',
      ts: '【コメント欄のタイムスタンプと説明】',
      chat: '【チャット盛り上がり時間帯（サンプルコメント付き）】',
      none: '（なし）',
      dur: d => `動画の総時間：${fmt(d)}`,
      out: '以下の 3 部構成で出力してください：',
      items: [
        '1. 動画の内容まとめ（3〜5 段落）',
        '2. 内容別のタイムライン：1 行 1 区間で「時間 タイトル：一言説明」の形式、順番に全編をカバー',
        m => `3. ネットスラング・専門用語の解説：資料に現れたネットスラング・業界用語・固有名詞を取り上げ、一つずつ日本語で説明${m ? `（最大 ${m} 件、重要度の高い順に）` : ''}`,
      ],
      req: '条件：時間の形式は M:SS または H:MM:SS。資料にある情報のみを使い、捏造しないこと。時間区間は動画の最後まで省略なくカバーし、長い区間を一つにまとめないこと。出力の長さがどうしても制限される場合は説明文を簡潔にできますが、タイムスタンプ区間の項目は一つも欠けずに全て含めてください。',
      strict: '出力はすべて日本語のみで行うこと（引用文・固有名詞を除く）。中国語の見出し・語句を一切混ぜないこと。',
      extraHead: '【ユーザーの追加要件】（上記の形式指定と矛盾しない範囲でできるだけ従うこと）',
    },
    'English': {
      role: 'You are a professional video content analyst. Below are three kinds of material from a YouTube live archive:',
      info: m => `[Video info]\nTitle: ${m.title || '(none)'}\nChannel: ${m.author || '(none)'}`,
      subs: '[Subtitles (chronological)]',
      ts: '[Timestamps and notes from comments]',
      chat: '[Chat highlight moments (with sample messages)]',
      none: '(none)',
      dur: d => `Total duration: ${fmt(d)}`,
      out: 'Produce the following three sections:',
      items: [
        '1. Video summary (3-5 paragraphs)',
        '2. Timeline by content: one line per segment, format "time title: one-sentence note", covering the whole video in order',
        m => `3. Slang & terminology notes: list the internet slang, jargon and proper nouns found in the material and explain each in English${m ? ` (at most ${m} entries, pick the most important)` : ''}`,
      ],
      req: 'Rules: use M:SS or H:MM:SS time format; only use information present in the material, do not fabricate; the timeline must cover the whole video up to the end, without skipping or merging long stretches. If the output length is truly limited, you may compress the wording, but every timeline entry covering the entire video must still be present.',
      strict: 'Write EVERYTHING in English, including all section headings (quoted text and proper nouns excepted). Do not mix in Chinese or any other language.',
      extraHead: '[User custom requirements] (follow them as long as they do not conflict with the format rules above)',
    },
  };

  // 直播类型预设：按类型给总结侧重点（随输出语言）。auto = 让模型依标题/内容自行判断。
  const LIVE_TYPE_GUIDES = {
    auto: {
      zh: '直播类型：未指定。请根据视频标题与材料内容自行判断直播类型（如杂谈、游戏实况、联动、歌回等），并按该类型的惯例组织总结与时间段划分。',
      en: 'Live type: unspecified. Infer the stream type from the title and material (talk / gaming / collab / singing etc.) and organize the summary accordingly.',
      ja: '配信タイプ：未指定。タイトルと資料から配信の種類（雑談/ゲーム/コラボ/歌枠など）を判断し、それに合った切り口でまとめてください。',
    },
    talk: {
      zh: '直播类型：杂谈。时间段按话题切换划分；总结各话题的趣闻、名场面与观众反应；用语说明侧重弹幕梗、网络流行语与频道内梗。',
      en: 'Live type: talk stream. Divide the timeline by topic switches; summarize anecdotes, memorable moments and viewer reactions; glossary should focus on chat memes and internet slang.',
      ja: '配信タイプ：雑談。話題の切り替わりごとに区間を分け、逸話・名場面・視聴者の反応をまとめる。用語解説はコメントの流行り言葉やチャンネル内ネタを中心に。',
    },
    game: {
      zh: '直播类型：游戏实况。时间段按游戏进程划分（开始游玩/关卡推进/关键抉择/结局达成等）；总结关键操作、失误与剧情进展；用语说明侧重游戏名、角色名与攻略术语。',
      en: 'Live type: gaming. Divide the timeline by game progress (start / stages / key choices / endings); summarize key plays, mistakes and story progress; glossary should cover game titles, characters and strategy terms.',
      ja: '配信タイプ：ゲーム実況。ゲームの進行（開始/ステップ/分岐/エンディング）ごとに区間を分け、キープレイ・ミス・ストーリー進行をまとめる。用語解説はゲーム名・キャラ名・攻略用語を中心に。',
    },
    collab: {
      zh: '直播类型：联动。时间段按联动环节划分；标注每位参与者的高光发言与互动笑点；用语说明侧重参与者称呼、组合名与圈内梗。',
      en: 'Live type: collab. Divide the timeline by segments; highlight the best lines of each participant and interactions; glossary should cover participants, group names and inside jokes.',
      ja: '配信タイプ：コラボ。コーナーごとに区間を分け、参加者それぞれの見せ場や掛け合いの笑いどころをまとめる。用語解説は参加者の呼び名・組み合わせ・業界ネタを中心に。',
    },
    song: {
      zh: '直播类型：歌回。每首歌曲单独一个时间段（含曲名与原唱信息）；记录合唱、即兴改编与点歌互动；用语说明侧重歌曲与演唱相关术语。',
      en: 'Live type: singing stream. One timeline entry per song (with song title); record duets, improvisations and song requests; glossary should cover music-related terms.',
      ja: '配信タイプ：歌枠。楽曲ごとに区間を分け（曲名つき）、デュエット・即興アレンジ・リクエスト対応を記録。用語解説は楽曲や歌唱に関する用語を中心に。',
    },
    other: {
      zh: '直播类型：其他。按活动环节划分时间段，总结整体流程、亮点与观众反应。',
      en: 'Live type: other. Divide the timeline by activity segments; summarize the flow, highlights and viewer reactions.',
      ja: '配信タイプ：その他。コーナーごとに区間を分け、全体の流れ・見どころ・視聴者の反応をまとめる。',
    },
  };
  function buildPrompt(mat, outLang, extra, type, glossaryMax) {
    const T = PROMPT_TEMPLATES[outLang] || PROMPT_TEMPLATES['简体中文'];
    const extraText = String(extra || '').trim();
    return [
      T.role,
      T.info(mat),
      `${T.subs}\n${mat.subs || T.none}`,
      `${T.ts}\n${mat.ts || T.none}`,
      `${T.chat}\n${mat.chatText || T.none}`,
      T.dur(mat.dur),
      '',
      T.out,
      ...T.items.map(it => typeof it === 'function' ? it(glossaryMax) : it),
      T.req,
      T.strict,
      (() => {
        const code = outLang === 'English' ? 'en' : outLang === '日本語' ? 'ja' : 'zh';
        const g = LIVE_TYPE_GUIDES[type] || LIVE_TYPE_GUIDES.auto;
        return g[code] || g.zh;
      })(),
      extraText ? `${T.extraHead}\n${extraText}` : '',
    ].filter(Boolean).join('\n');
  }

  // 服务商预设库：识别 URL → 自动归一化端点/鉴权头/模型示例。
  // 协议统一为 openai（Bearer + /chat/completions）或 anthropic（x-api-key + /v1/messages）。
  const PROVIDERS = [
    { re: /openrouter\.ai/i, name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', proto: 'openai',
      models: 'qwen/qwen3.8-27b:free、deepseek/deepseek-chat-v3.1:free', note: '免费模型多人共享、偶尔 429 限流，重试或换模型即可' },
    { re: /api\.anthropic\.com/i, name: 'Anthropic 官方', base: 'https://api.anthropic.com/v1', proto: 'anthropic',
      models: 'claude-sonnet-4-5、claude-haiku-4-5' },
    { re: /open\.bigmodel\.cn/i, name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', proto: 'openai',
      models: 'glm-4.6、glm-4.5-flash（按量计费；Coding Plan 订阅按条款仅限官方工具，浏览器扩展请用按量 API）' },
    { re: /api\.deepseek\.com/i, name: 'DeepSeek', base: 'https://api.deepseek.com/v1', proto: 'openai',
      models: 'deepseek-chat、deepseek-reasoner' },
    { re: /dashscope\.aliyuncs\.com/i, name: '阿里通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', proto: 'openai',
      models: 'qwen-plus、qwen-turbo' },
    { re: /open\.i\.ai|minimax/i, name: 'MiniMax', base: 'https://api.minimax.chat/v1', proto: 'openai',
      models: 'abab6.5s-chat' },
    { re: /moonshot\.cn|x\.ai/i, name: 'Moonshot Kimi', base: 'https://api.moonshot.cn/v1', proto: 'openai',
      models: 'moonshot-v1-8k、kimi-k2-0905-preview' },
    { re: /aify|siliconflow|siliconflow\.cn/i, name: '硅基流动', base: 'https://api.siliconflow.cn/v1', proto: 'openai',
      models: 'Qwen/Qwen2.5-7B-Instruct（部分模型免费）' },
    { re: /localhost:11434|127\.0\.0\.1:11434/i, name: 'Ollama 本地', base: 'http://localhost:11434/v1', proto: 'openai',
      models: 'qwen2.5:7b、llama3.1:8b（本地已 pull 的模型名）' },
    { re: /localhost:1234|127\.0\.0\.1:1234/i, name: 'LM Studio 本地', base: 'http://localhost:1234/v1', proto: 'openai',
      models: '本地加载的模型名' },
    { re: /generativelanguage\.googleapis\.com|gemini/i, name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', proto: 'openai',
      models: 'gemini-2.0-flash、gemini-2.5-flash' },
    { re: /mistral\.ai/i, name: 'Mistral', base: 'https://api.mistral.ai/v1', proto: 'openai',
      models: 'mistral-small-latest' },
    { re: /groq\.com/i, name: 'Groq', base: 'https://api.groq.com/openai/v1', proto: 'openai',
      models: 'llama-3.3-70b-versatile' },
  ];

  // 归一化配置：返回 { base, proto, providerName }
  function normalizeEndpoint(cfg) {
    let base = (cfg.url || '').replace(/\/+$/, '');
    if (!base) return { base: 'https://api.openai.com/v1', proto: 'openai', providerName: '' };

    // OpenRouter：模型介绍页 URL 也能用（自动剥路径补 API 前缀，带出模型名）
    if (/openrouter\.ai/i.test(base) && !/\/api\//i.test(base)) {
      const m = base.match(/^https?:\/\/openrouter\.ai\/([^/?#]+\/[^/?#]+)/i);
      const modelName = m ? decodeURIComponent(m[1]) : '';
      if (modelName && (!cfg.model || cfg.model === DEFAULT_MODEL)) {
        cfg = { ...cfg, model: modelName };
      }
      base = 'https://openrouter.ai/api/v1';
    }

    // 协议判定优先于预设改写：URL 含 anthropic → Anthropic 协议，保留用户填的端点
    if (/anthropic/i.test(base)) {
      // Anthropic 官方域名自动补全版本路径；其他 anthropic 端点保持用户填写的路径
      if (/api\.anthropic\.com/i.test(base) && !/\/v\d+/i.test(base)) {
        base = base + '/v1';
      }
      return { base, proto: 'anthropic', providerName: '' };
    }
    // 供应商预设匹配（用户只填域名也能自动补全）
    const p = PROVIDERS.find(p => p.re.test(base) && p.proto === 'openai');
    if (p && !/chat\/completions$|\/messages$|\/v\d+(\/|$)/i.test(base)) {
      base = p.base;
    }
    return { base, proto: 'openai', providerName: p ? p.name : '' };
  }

  async function callLLM(cfg, prompt, onChunk) {
    const hardDeadline = Date.now() + 5 * 60 * 1000;   // 总时长上限 5 分钟
    const { base, proto } = normalizeEndpoint(cfg);
    let url, headers, body, pick;
    if (proto === 'anthropic') {
      // Anthropic 协议：x-api-key 头 + anthropic-version + /v1/messages；响应取 content[].text
      url = base.replace(/\/v1\/?$/, '') + '/v1/messages';
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': cfg.key,
        'anthropic-version': '2023-06-01',
      };
      body = { model: cfg.model, max_tokens: 16384, messages: [{ role: 'user', content: prompt }] };   // 长视频总结需要大输出空间，模型不支持时自动降级重试
      pick = data => (data?.content || []).map(c => c.text || '').join('');
    } else {
      // OpenAI 兼容协议：Bearer 头 + /chat/completions；响应取 choices[0].message.content。
      // 不传 max_tokens（由服务端按模型上限处理）；兼容 OpenRouter 的 HTTP-Referer/X-Title 惯例头
      url = base + '/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        ...(cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}),
      };
      body = {
        model: cfg.model,
        messages: [
          { role: 'system', content: 'You are a professional video content analyst. Always write the ENTIRE response in the language the user prompt asks for, including all headings — never mix languages (quoted text and proper nouns excepted).' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
      };
      pick = data => data?.choices?.[0]?.message?.content || '';
    }
    // 流式优先（stream:true）：服务端立即开始返回增量 token，避免非流式长等待。
    // 逐块读取 + 空闲超时保护（相邻块间隔 >60s 判定挂死），并支持流中进度反馈。
    body.stream = true;

    // 自动重试：429 限流退避 8s；400 且提示 max_tokens 超限时逐级降低输出上限
    // （Anthropic 协议必须带 max_tokens，个别模型上限低于 16384 会报 400）
    let maxTokens = 16384;
    let res = null;
    let errText = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const attemptBody = proto === 'anthropic' ? { ...body, max_tokens: maxTokens } : body;
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(attemptBody) }).catch(() => null);
      if (res && res.ok) break;
      errText = res ? await res.text().catch(() => '') : '';
      if (res && res.status === 400 && /max.?tokens/i.test(errText) && maxTokens > 4096) {
        maxTokens = maxTokens > 8192 ? 8192 : 4096;
        continue;   // 立即降级重试（无等待）
      }
      if (res && res.status === 429 && attempt < 2) {
        await new Promise(r => setTimeout(r, 8000));
        continue;
      }
      break;
    }
    if (!res) {
      // 浏览器层失败：扩展已持有 <all_urls> 主机权限，CORS 不再拦截——
      // 剩下常见原因是地址拼错（域名/路径）、把网页地址当 API 地址、或网络/代理不通
      throw new Error(`Failed to fetch——请求根本没到达 API 服务器。提示：核对 API 地址（如硅基流动 https://api.siliconflow.cn/v1、智谱 https://open.bigmodel.cn/api/paas/v4、OpenRouter https://openrouter.ai/api/v1）；确认网络可直连该服务商；本地模型确认 Ollama/LM Studio 已启动`);
    }
    if (!res.ok) {
      let extra = '';
      errText = errText || '';
      // 429 code 1113（余额不足）：paas 端点扣普通 API 余额
      if (res.status === 429 && /1113|余额不足|资源包/.test(errText)) {
        extra = '。提示：该端点扣的是普通 API 余额——请充值，或在智谱控制台更换有余额的模型/端点';
      }
      // 429 上游限流（免费模型共享额度被占满）：重试后仍失败——建议换模型
      if (res.status === 429 && /rate-?limited|temporarily/i.test(errText)) {
        extra = '。提示：该免费模型当前被限流（重试后仍占用）——稍等几分钟再试，或在 OpenRouter 换一个 :free 模型（如 deepseek/deepseek-chat-v3.1:free、meta-llama/llama-3.3-70b-instruct:free）';
      }
      // 403 model_access_denied：Key 有效但该模型无权限
      if (res.status === 403 && /model_access_denied|No permission/i.test(errText)) {
        extra = '。提示：当前 Key 无权访问该模型——请到智谱控制台确认模型名与开通状态';
      }
      // 404：API 地址不正确（常见：把模型介绍页当 API 地址填入）
      if (res.status === 404) {
        extra = '。提示：API 地址不正确——OpenRouter 应填 https://openrouter.ai/api/v1（模型名如 qwen/qwen3.8-27b:free），智谱填 https://open.bigmodel.cn/api/paas/v4';
      }
      throw new Error(`HTTP ${res.status} ${errText.slice(0, 200)}${extra}`);
    }

    // 逐块读取流（兼容流式 SSE 与非流式 JSON）：
    // 空闲超时 60s（相邻块间隔）；总时长上限 5 分钟。
    // 收到任何数据即回调 onChunk 供界面显示进度（思考型模型的 reasoning 块也算“有响应”）。
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytesIn = 0;
    for (;;) {
      let chunk;
      try {
        const idle = new Promise((_, rej) => setTimeout(() => rej(new Error('IDLE_TIMEOUT')), 60000));
        const read = reader.read();
        chunk = await Promise.race([read, idle]);
      } catch (e) {
        try { reader.cancel(); } catch {}
        break;   // 空闲超时或流结束：用已收到的内容走下方解析
      }
      if (chunk.done) break;
      bytesIn += chunk.value ? chunk.value.length : 0;
      text += decoder.decode(chunk.value, { stream: true });
      if (onChunk) onChunk(bytesIn);
      if (Date.now() > hardDeadline) { try { reader.cancel(); } catch {} break; }
    }

    // 流式响应：解析 SSE 数据行（data: {...} / data: [DONE]），拼接增量内容
    if (body.stream && text.includes('data:')) {
      let out = '';
      let sawDone = false;
      let firstErr = '';
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { sawDone = true; continue; }
        try {
          const chunk = JSON.parse(payload);
          if (chunk.error) { firstErr = chunk.error.message || JSON.stringify(chunk.error); break; }
          const delta = chunk.choices?.[0]?.delta?.content
                     || chunk.choices?.[0]?.message?.content
                     || chunk.choices?.[0]?.delta?.reasoning_content && ''
                     || (Array.isArray(chunk.content) ? chunk.content.map(c => c.text || '').join('') : '');
          if (delta) out += delta;
        } catch {}
      }
      if (!out && firstErr) throw new Error(`服务商错误：${firstErr.slice(0, 160)}`);
      if (out) return out;
      if (sawDone && !out) throw new Error('流式响应结束但内容为空——若模型为思考型请稍后再试或更换模型');
      // 非流式 JSON 回退（端点不支持 stream 时）
      try {
        const data = JSON.parse(text);
        const fallback = pick(data) || '';
        if (fallback) return fallback;
        if (data.error || (data.msg && !data.choices && !data.content)) {
          throw new Error(`服务商错误：${String(data.error?.message || data.msg || JSON.stringify(data)).slice(0, 160)}`);
        }
      } catch (e) {
        if (String(e.message).startsWith('服务商错误')) throw e;
      }
      throw new Error(`流式响应未解析出内容：${text.slice(0, 160)}`);
    }

    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`响应为空或非 JSON${text ? `：${text.slice(0, 120)}` : '（模型长时间未返回内容，请重试或更换模型）'}`); }
    // 服务商业务错误常包在 HTTP 200 里（如智谱 {code:500,msg:...}）
    if (data.error || (data.msg && !data.choices && !data.content)) {
      throw new Error(`服务商错误：${String(data.error?.message || data.msg || JSON.stringify(data)).slice(0, 160)}`);
    }
    const out = pick(data) || '';
    if (!out) throw new Error(`模型返回为空：${text.slice(0, 160)}`);
    return out;
  }

  async function generate(onProgress, onChunk) {
    if (generating) return null;
    generating = true;
    try {
      const cfg = await loadCfg();
      onProgress && onProgress('gather');
      const mat = await gatherMaterial();
      onProgress && onProgress('llm');
      return await callLLM(cfg, buildPrompt(mat, outLanguage(cfg.outLang), cfg.extra, cfg.type, cfg.glossaryMax), onChunk);
    } finally {
      generating = false;
    }
  }

  // ---------- 总结缓存（按视频 ID 存 chrome.storage.local，刷新页面后可恢复） ----------

  const AI_CACHE_KEY = 'ytexAiCache';
  const AI_CACHE_MAX = 20;         // 最多保留最近 20 个视频的总结（按生成时间 LRU）

  function readCache() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get([AI_CACHE_KEY], d => {
          if (chrome.runtime.lastError || !d) resolve({});
          else resolve(d[AI_CACHE_KEY] || {});
        });
      } catch { resolve({}); }
    });
  }

  function writeCache(map) {
    try {
      chrome.storage.local.set({ [AI_CACHE_KEY]: map }, () => { void chrome.runtime.lastError; });
    } catch {}
  }

  async function getCachedSummary(vid) {
    if (!vid) return null;
    const map = await readCache();
    const e = map[vid];
    return e && e.text ? e : null;
  }

  async function cacheSummary(vid, text) {
    if (!vid || !text) return;
    const map = await readCache();
    map[vid] = { text, at: Date.now() };
    const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at);
    writeCache(Object.fromEntries(entries.slice(0, AI_CACHE_MAX)));
  }

  // 清除某视频的总结缓存（面板「清除缓存」按钮），返回是否成功
  async function clearCachedSummary(vid) {
    if (!vid) return false;
    try {
      const map = await readCache();
      delete map[vid];
      writeCache(map);
      return true;
    } catch {
      return false;
    }
  }

  // ---------- 追问：基于已总结内容缓存，继续提问视频相关问题 ----------

  const FOLLOWUP_HISTORY_MAX = 6;   // 携带的对话轮数上限（超出丢最旧的）

  // 追问提示词：总结优先；总结没有的信息回退到原始素材（字幕原文/评论时间戳/聊天高能）。
  // cueMap：问题中提到的时间点 → 该时刻附近的字幕原文（支持"逐句翻译某片段"类问题）。
  function buildFollowupPrompt(summary, mat, history, question, outLang) {
    const langName = outLang;
    const parts = [
      `你是该 YouTube 视频的分析助手。回答用户的追问时遵循以下信息优先级：`,
      `1. 优先使用【已生成的视频总结】中的内容；`,
      `2. 总结中没有的信息，使用【补充材料】（字幕原文/评论时间戳/聊天高能）回答；`,
      `3. 两者都没有的，如实说明无法得知，不要编造。`,
      `请用 ${langName} 回答，保持简洁。`,
      '',
      `【视频信息】标题：${mat.title || '（未知）'} ｜ 频道：${mat.author || '（未知）'}`,
      '',
      summary ? `【已生成的视频总结】\n${summary}` : '【已生成的视频总结】（尚未生成总结——请直接依据补充材料回答）',
    ];
    if (mat.cues && mat.cues.length) {
      parts.push(`【问题涉及时段的字幕原文】\n${mat.cues}`);
    }
    if (mat.ts) {
      parts.push(`【评论区时间戳与说明（节选）】\n${mat.ts}`);
    }
    if (mat.chatText) {
      parts.push(`【聊天高能时段（节选）】\n${mat.chatText}`);
    }
    const convo = history
      .slice(-FOLLOWUP_HISTORY_MAX)
      .map(h => `${h.role === 'user' ? '用户' : '助手'}：${h.content}`)
      .join('\n\n');
    if (convo) parts.push(`【此前的追问对话】\n${convo}`);
    parts.push(`【用户的追问】\n${question}`);
    return parts.filter(Boolean).join('\n');
  }

  // 从问题中提取时间点（M:SS / H:MM:SS / 纯秒数），返回秒数组
  function extractQuestionTimes(question) {
    const times = [];
    const re = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/g;
    let m;
    while ((m = re.exec(question))) {
      const h = m[1] ? Number(m[1]) : 0;
      times.push(h * 3600 + Number(m[2]) * 60 + Number(m[3]));
    }
    return times;
  }

  // 问题提到某时间点时，把该点前后各 90 秒的字幕原文（含时间戳）注入素材，
  // 使"给出某个片段的逐句翻译"这类问题可答
  function cuesAround(cues, times, maxChars) {
    if (!cues || !cues.length || !times.length) return '';
    const WIN = 90;
    const windows = times.map(t => [Math.max(0, t - WIN), t + WIN]);
    const lines = [];
    let out = '';
    for (const c of cues) {
      const mid = (c.start + c.end) / 2;
      if (!windows.some(([a, b]) => mid >= a && mid <= b)) continue;
      const line = `${fmt(Math.round(c.start))} ${c.text}`;
      if (out.length + line.length + 1 > maxChars) break;
      out += line + '\n';
    }
    return out.trim();
  }

  async function followup(question, onChunk) {
    if (generating) return null;
    const vid = YTEX.video.videoId();
    const cached = await getCachedSummary(vid);
    // 总结不再是必要条件：没有总结也能依据原始素材回答
    generating = true;
    try {
      const cfg = await loadCfg();
      const state = await loadFollowupState(vid);
      followupState.set(vid, state);
      // 素材：字幕（含问题时间窗原文）、评论时间戳、聊天高能
      let cues = [];
      let title = '';
      let author = '';
      let ts = '';
      let chatText = '';
      try {
        const sub = await fetchSubtitles(vid, SUB_MAX_CHARS);
        cues = sub.cues || [];
        title = sub.title || '';
        author = sub.author || '';
      } catch {}
      if (!title) {
        try { title = document.title.replace(/\s*[-\u2013\u2014]\s*YouTube\s*$/i, '').trim(); } catch {}
      }
      try {
        ts = (YTEX.comments.getTimestamps?.() || []).slice(0, 60)
          .map(r => `${fmt(r.time)} ${String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`)
          .join('\n').slice(0, 2000);
      } catch {}
      try {
        const chat = YTEX.chat.getChatMaterial?.() || { peaks: [] };
        chatText = chat.peaks
          .map(pk => `${fmt(pk.start)}（发笑 ${pk.laugh}）：${pk.samples.join(' / ')}`)
          .join('\n').slice(0, 2000);
      } catch {}
      const mat = {
        title, author, ts, chatText,
        cues: cuesAround(cues, extractQuestionTimes(question), 8000),
      };
      const prompt = buildFollowupPrompt(
        cached ? cached.text : '', mat,
        state.history, question, outLanguage(cfg.outLang),
      );
      const answer = await callLLM(cfg, prompt, onChunk);
      state.history.push({ role: 'user', content: question });
      state.history.push({ role: 'assistant', content: answer });
      if (state.history.length > FOLLOWUP_HISTORY_MAX * 2) {
        state.history = state.history.slice(-FOLLOWUP_HISTORY_MAX * 2);
      }
      schedulePersistFollowup(vid);
      return answer;
    } finally {
      generating = false;
    }
  }

  // 每个视频独立的追问历史：内存缓存 + chrome.storage.local 持久化（刷新/重开浏览器后可继续追问）。
  // 与 panel.js 共用键 ytexAiFollowups（形如 { [vid]: { history, at } }，按 at 保留最近 20 个视频）。
  const followupState = new Map();
  const FOLLOWUP_STORE_KEY = 'ytexAiFollowups';
  const FOLLOWUP_STORE_VIDS = 20;

  // 读取某视频的追问历史：内存有缓存直接返回，否则从持久化存储恢复
  function loadFollowupState(vid) {
    const cached = followupState.get(vid);
    if (cached) return Promise.resolve(cached);
    return new Promise(resolve => {
      const done = state => { followupState.set(vid, state); resolve(state); };
      try {
        chrome.storage.local.get([FOLLOWUP_STORE_KEY], d => {
          try {
            const e = d && d[FOLLOWUP_STORE_KEY] && d[FOLLOWUP_STORE_KEY][vid];
            done({ history: e && Array.isArray(e.history) ? e.history : [], at: (e && e.at) || 0 });
          } catch { done({ history: [], at: 0 }); }
        });
      } catch { done({ history: [], at: 0 }); }
    });
  }

  // 追问结束后持久化该视频历史（LRU：按 at 保留最近 20 个视频）
  function schedulePersistFollowup(vid) {
    const state = followupState.get(vid);
    if (!vid || !state) return;
    try {
      chrome.storage.local.get([FOLLOWUP_STORE_KEY], d => {
        try {
          const all = (d && d[FOLLOWUP_STORE_KEY]) || {};
          all[vid] = { history: state.history, at: Date.now() };
          const entries = Object.entries(all)
            .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
            .slice(0, FOLLOWUP_STORE_VIDS);
          const payload = {};
          for (const [k, v] of entries) payload[k] = v;
          chrome.storage.local.set({ [FOLLOWUP_STORE_KEY]: payload }, () => { void chrome.runtime.lastError; });
        } catch {}
      });
    } catch {}
  }

  // 清空某视频的追问历史（重新生成总结 / 面板「清空对话」调用）：内存与持久化一并清除
  function resetFollowup(vid) {
    if (!vid) return;
    followupState.delete(vid);
    try {
      chrome.storage.local.get([FOLLOWUP_STORE_KEY], d => {
        try {
          const all = (d && d[FOLLOWUP_STORE_KEY]) || {};
          if (!all[vid]) return;
          delete all[vid];
          chrome.storage.local.set({ [FOLLOWUP_STORE_KEY]: all }, () => { void chrome.runtime.lastError; });
        } catch {}
      });
    } catch {}
  }

  YTEX.ai = {
    generate,
    followup,
    resetFollowup,
    isGenerating: () => generating,
    getCachedSummary,
    cacheSummary,
    clearCachedSummary,
    _normalize: normalizeEndpoint,   // 供测试/设置页自动补全使用
    PROVIDERS,
  };
})();
