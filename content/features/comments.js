// 需求1：评论区时间戳。
// 主路径：Innertube next 接口全量拉取（无需模拟滚动）；兜底：DOM 观察 + 受控滚动。
// 三级时间戳来源：commandRuns startTimeSeconds > 链接 t 参数 > 纯文本正则；
// 按 commentId（接口）/ 作者+文本（DOM）去重，合法性校验（不超视频时长），
// 每 300ms 合并渲染一次流式写入边栏。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};
  const I = (k, ...a) => YTEX.i18n.t(k, ...a);

  const MAX_PAGES = 150;         // 单视频翻页上限（每页约 20 条 ≈ 3000 条评论）
  const PAGE_DELAY_MS = 200;     // 限速 ≈5 req/s
  const RENDER_DEBOUNCE_MS = 300;
  const TEXT_MAX = 500;
  const FULL_MAX = 2000;         // 详情视图的全文截断上限
  const DOM_SCROLL_INTERVAL_MS = 600;
  const DOM_MAX_STEPS = 600;     // 自动滚动步数上限（约 6 分钟，覆盖超长评论区）
  const DOM_STABLE_LIMIT = 3;    // 无新增且无加载指示器后，再观察几拍才算完成
  const REPLIES_MAX_FETCH = 60;  // 楼中楼回复请求上限

  let gen = 0;                   // 会话代号：stop/重开自增，旧异步链路据此退出
  let fallbackReason = '';       // 接口路径失败原因（DOM 兜底时持续显示，便于定位）
  let debugSample = null;        // 首页原始结构样本（0 时间戳时导出到控制台）
  let entries = [];
  let seenKeys = new Set();
  let scanCount = 0;
  let renderTimer = 0;
  let domObserver = null;
  let scrollTimer = null;
  let retryTimer = null;
  let replyTokens = [];          // 楼中楼回复续页 token 队列

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- 数据入库与流式渲染 ----------

  function makeEntry(time, snippet, fullText, author, likes, dedupBase) {
    return {
      time,
      text: snippet.slice(0, TEXT_MAX),
      fullText: fullText.slice(0, FULL_MAX),
      author,
      likes,
      key: `${dedupBase}|${time}`,
      commentKey: dedupBase,       // 同一评论的多个时间戳共享，供"全文详情"聚合
    };
  }

  // 去掉片段首尾的空白与分隔标点。【】（）[]等括号不清理——它们常是标题的一部分（如"【マクドナルド】"）
  // 句尾的表情 token（":快捷名:"）整体保留：收尾冒号被当标点清掉会导致渲染时匹配不到表情
  const SEG_TRIM = /^[\s,.;:、，。；~～\-—|]+|[\s,.;:、，。；~～\-—|]+$/g;
  const EMOTE_TAIL = /:[^:\s]{1,60}:$/;
  const cleanSeg = seg => {
    if (EMOTE_TAIL.test(seg)) return seg.replace(/^\s+|\s+$/g, '').trim();
    return seg.replace(SEG_TRIM, '').trim();
  };

  // 片段以"在/是/到"等指代词结尾时，说明它在描述下一个时间戳（"第二段在 5:40"写法）
  const REF_END = /(?:在|是|到|看|跳|于|:|：|→|->)$/;

  // 日系评论的行首标记（"∟"/"└" 树形装饰、"●"/"★" 项目符号）：
  // 都写在下一行时间戳的行首，单独成行时只是标记——
  // 携带给下一个时间戳（前缀到其描述的开头），不丢弃也不悬挂在上一个时间戳上
  const MARKER_CHARS = '∟└┗├┣┃│─｜|╰╭╮╯┊┋↳●○◎★☆◆◇■□▲△▼▽♪♡♥♦♣♠※✚✔';
  const MARKER_LINE = new RegExp('^[ \\t\\u3000]*[' + MARKER_CHARS + '][ \\t\\u3000]*$');
  const stripMarkerTail = seg => {
    const lines = seg.split('\n');
    const marks = [];
    while (lines.length && MARKER_LINE.test(lines[lines.length - 1])) marks.unshift(lines.pop().trim());
    return { seg: lines.join('\n'), marks: marks.join('') };
  };

  // 每个时间戳的"其后片段"（本时间戳到下一个时间戳之间的文字，已清理）。
  // 片段尾部的标记行携带给下一个时间戳（前缀到其描述）。
  // 另外：时间戳所在段落（上一个空行之后）里、时间戳行之前的说明行
  // （如 "●話題を変えよう"）也归属本时间戳——它们曾被空行截断扔进无主地带
  function buildAfterSegs(text, hits) {
    const segs = [];
    let carry = '';
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      let start = i > 0 ? hits[i - 1].pos + hits[i - 1].len : 0;
      const lineStart = text.lastIndexOf('\n', h.pos - 1) + 1;
      const paraStart = text.lastIndexOf('\n\n', h.pos) + 2;
      let header = '';
      if (paraStart > start && paraStart < lineStart) {
        // 段落起点在上一时间戳之后：段落头（时间戳行之前的行）是本时间戳的说明
        header = cleanSeg(text.slice(paraStart, lineStart));
        if (header) start = lineStart;
      }
      let end = i + 1 < hits.length ? hits[i + 1].pos : text.length;
      const paraEnd = text.indexOf('\n\n', h.pos + h.len);
      if (paraEnd >= 0 && paraEnd < end) end = paraEnd;
      const lines = text.slice(h.pos + h.len, end).split('\n');
      const marks = [];
      while (lines.length && MARKER_LINE.test(lines[lines.length - 1])) marks.unshift(lines.pop().trim());
      let seg = cleanSeg(lines.join('\n'));
      if (header) seg = seg ? header + '\n' + seg : header;
      if (carry && seg) seg = carry + seg;
      else if (carry && !seg) marks.unshift(carry);
      carry = marks.join('');
      segs.push(seg);
    }
    return segs;
  }

  // 为第 i 个时间戳截取"相关文本"（判断逻辑）：
  // 1) 从自身向后扫描其后片段，第一个非空的即"本组描述"——连排时间戳共享同一段说明
  //    （"6:30 57:52 1:00:27 こういう独特の例え方好き"）；片段以指代词结尾（"第二段在"）
  //    时属于下一个时间戳，放弃本组描述走 2)
  // 2) 取其前、上一个时间戳之后的文字（"这段太搞笑了 3:21"写法）
  // 3) 再退：首个时间戳前的整体前缀 → 末尾后缀 → 全文
  // 判空一律基于清理标点后的内容：全宽顿号等不是 Unicode 空白，trim() 判不出来
  function snippetFor(text, hits, afterSegs, i) {
    for (let j = i; j < hits.length; j++) {
      const seg = afterSegs[j];
      if (!seg) continue;
      if (REF_END.test(seg)) break;
      return seg;
    }
    if (i > 0) {
      const raw = text.slice(hits[i - 1].pos + hits[i - 1].len, hits[i].pos);
      const { seg: rawSeg, marks } = stripMarkerTail(raw);
      const seg = cleanSeg(rawSeg);
      if (seg) return marks + seg;
      if (marks) return marks;
    }
    const head = cleanSeg(text.slice(0, hits[0].pos));
    if (head) {
      // 时间戳在评论末尾的写法（"正文…\n\nファーマー1位発表　6:24:56"）：
      // 前缀跨多行时只取时间戳所在行/最近的非空行，隔段正文不要
      const lines = head.split('\n');
      const marks = [];
      for (let k = lines.length - 1; k >= 0; k--) {
        if (MARKER_LINE.test(lines[k])) { marks.unshift(lines[k].trim()); continue; }
        const seg = cleanSeg(lines[k]);
        if (seg) return marks.join('') + seg;
      }
      if (marks.length) return marks.join('');
      return head;
    }
    const last = hits[hits.length - 1];
    const tail = cleanSeg(text.slice(last.pos + last.len));
    return tail || text.trim();
  }

  // 内容级去重集合：时间 + 提取后的说明文字 完全一致的条目只保留一条
  const seenContent = new Set();

  function addEntries(list) {
    let added = false;
    for (const e of list) {
      if (seenKeys.has(e.key)) continue;
      const dur = YTEX.video.duration();
      if (dur > 0 && e.time > dur) continue;           // 校验：不超视频时长
      if (e.time <= 0 || e.time > 86400 * 3) continue; // 基本合法性
      // 内容级去重：相同时间 + 相同提取文字的条目视为重复（不同楼层常见）
      const contentKey = e.time + '|' + e.text;
      if (seenContent.has(contentKey)) continue;
      seenKeys.add(e.key);
      seenContent.add(contentKey);
      entries.push(e);
      added = true;
    }
    if (added) scheduleRender();
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      YTEX.panel.setTimestamps(entries);
      setStatusComments('评论扫描中：已扫 {0} 条 · 命中 {1} 个时间戳', scanCount, entries.length);
    }, RENDER_DEBOUNCE_MS);
  }

  // ---------- 状态栏（comments 段）----------
  // 登记 key/args：语言切换后面板 applyTexts 回调 refreshStatus 重译当前状态

  let lastStatus = null;
  function setStatusComments(key, ...args) {
    lastStatus = { key, args };
    YTEX.panel.setStatus('comments', I(key, ...args));
  }
  function refreshStatus() {
    if (lastStatus) YTEX.panel.setStatus('comments', I(lastStatus.key, ...lastStatus.args));
  }

  function renderNow(key, ...args) {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
    lastStatus = { key, args };
    YTEX.panel.setTimestamps(entries);
    YTEX.panel.setStatus('comments', I(key, ...args));
  }

  // ---------- 主路径：Innertube 全量拉取 ----------

  // 定位评论区的初始 continuation token。
  // 优先精确匹配标准面板标识；深度查找只搜 content——避免误拿 header 里排序菜单的 token。
  function findCommentsToken(root) {
    const panels = (root?.engagementPanels || [])
      .map(p => p.engagementPanelSectionListRenderer)
      .filter(Boolean)
      .filter(p => String(p.panelIdentifier || '').includes('comment'));
    panels.sort((a, b) =>
      (a.panelIdentifier === 'engagement-panel-comments-section' ? 0 : 1)
      - (b.panelIdentifier === 'engagement-panel-comments-section' ? 0 : 1));
    for (const panel of panels) {
      const content = panel.content;
      if (!content) continue;
      const direct = content.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
        || YTEX.deepFind(content, 'continuationCommand', 8)?.token;
      if (direct) return direct;
    }
    return null;
  }

  // 收集一页响应里的全部 continuationItems。
  // 注意：next 的评论续页挂在 onResponseReceivedEndpoints（部分旧结构为 onResponseReceivedActions）
  function collectResponseItems(data) {
    const groups = data?.onResponseReceivedEndpoints || data?.onResponseReceivedActions || [];
    const items = [];
    for (const g of groups) {
      const c = g?.appendContinuationItemsAction?.continuationItems
             || g?.reloadContinuationItemsCommand?.continuationItems;
      if (c) items.push(...c);
    }
    return items;
  }

  // 取本页末尾的下一页 token
  function findNextToken(data) {
    const items = collectResponseItems(data);
    for (let i = items.length - 1; i >= 0; i--) {
      const cir = items[i]?.continuationItemRenderer;
      if (!cir) continue;
      const token = cir.continuationEndpoint?.continuationCommand?.token
                 || cir.button?.buttonRenderer?.command?.continuationCommand?.token;
      if (token) return token;
    }
    return null;
  }

  // 建立 mutation 索引：同时登记全键与去前缀的裸键（"comment:Ugxx" ↔ "Ugxx" 匹配不上是常见坑）
  function buildMutationIndex(data) {
    const byKey = new Map();
    for (const m of data?.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
      const p = m?.payload?.commentEntityPayload;
      if (!p || !m.entityKey) continue;
      byKey.set(m.entityKey, p);
      const bare = String(m.entityKey).split(':').pop();
      if (bare && !byKey.has(bare)) byKey.set(bare, p);
    }
    return byKey;
  }

  // commentThreadRenderer.commentViewModel 可能直接挂键，也可能再嵌套一层 commentViewModel
  function commentVm(thread) {
    const outer = thread.commentViewModel || {};
    return outer.commentViewModel || outer;
  }

  // 线程 → payload：commentKey / commentId 全键或裸键任一命中
  function payloadFor(thread, mutIndex) {
    const vm = commentVm(thread);
    for (const k of [vm.commentKey, vm.commentId, thread.comment?.commentRenderer?.commentId]) {
      if (!k) continue;
      const hit = mutIndex.get(k) || mutIndex.get(String(k).split(':').pop());
      if (hit) return hit;
    }
    return null;
  }

  // 从 payload 提取正文与时间戳链接 runs（content 可能是对象或纯字符串）
  function payloadText(payload) {
    const c = payload?.properties?.content;
    if (typeof c === 'string') return { text: c, runs: payload?.properties?.commandRuns || [] };
    if (c && typeof c === 'object') {
      return { text: c.content || '', runs: c.commandRuns || payload?.properties?.commandRuns || [] };
    }
    if (payload?.content?.content) {
      return { text: payload.content.content, runs: payload.content.commandRuns || [] };
    }
    return { text: '', runs: [] };
  }
  // 解析单条评论线程：现行 commentViewModel + frameworkUpdates（键双通道匹配），
  // 旧版 commentRenderer 兜底。每个时间戳命中记录其位置（pos/len），供 snippetFor 切分。
  function parseThread(thread, mutIndex) {
    const hits = [];                   // { time, pos, len }
    const seenT = new Set();
    let text = '', author = '', likes = '', base = null;

    const vm = commentVm(thread);
    const payload = payloadFor(thread, mutIndex);
    if (payload) {
      author = payload.author?.displayName || '';
      likes = payload.toolbar?.likeCountNotliked || payload.toolbar?.likeCountLiked || '';
      const pt = payloadText(payload);
      text = pt.text;
      for (const cr of pt.runs) {
        const t = cr?.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds;
        if (Number.isFinite(t) && t > 0 && !seenT.has(t)) {
          seenT.add(t);
          hits.push({ time: t, pos: cr.startIndex || 0, len: cr.length || 0 });
        }
      }
      base = vm.commentKey || vm.commentId || null;
    }

    const cr = thread.comment?.commentRenderer;
    if (cr) {
      base = base || cr.commentId || null;
      author = author || cr.authorText?.simpleText || (cr.authorText?.runs || []).map(r => r.text).join('');
      likes = likes || cr.voteCount?.simpleText || '';
      if (!text) {
        const runs = cr.contentText?.runs;
        if (runs) {
          let offset = 0;
          const parts = [];
          for (const r of runs) {
            const rText = r.text || '';
            const t = r?.navigationEndpoint?.watchEndpoint?.startTimeSeconds;
            if (Number.isFinite(t) && t > 0 && !seenT.has(t)) {
              seenT.add(t);
              hits.push({ time: t, pos: offset, len: rText.length });
            }
            offset += rText.length;
            parts.push(rText);
          }
          text = parts.join('');
        } else {
          text = cr.contentText?.simpleText || '';
        }
      }
    }

    if (!text) return [];

    // 三级来源：纯文本正则兜底（与链接命中值去重，同样记录位置）
    for (const m of text.matchAll(YTEX.tsRegex())) {
      const t = YTEX.clockToSeconds(m[0]);
      if (t !== null && t > 0 && !seenT.has(t)) {
        seenT.add(t);
        hits.push({ time: t, pos: m.index, len: m[0].length });
      }
    }

    if (!hits.length) return [];
    hits.sort((a, b) => a.pos - b.pos);
    const afterSegs = buildAfterSegs(text, hits);

    if (!base) base = `${author}|${text.slice(0, 80)}`;
    return hits.map((h, i) => makeEntry(h.time, snippetFor(text, hits, afterSegs, i), text, author, likes, base));
  }

  // 解析一页响应：入库顶层/回复评论，并收集线程内的楼中楼续页 token
  // 从 payload 直接产出时间戳条目（楼中楼新结构的兜底：有些回复页的回复
  // 只存在于 frameworkUpdates 的 mutations 里，items 上没有对应渲染器形状）
  function entriesFromPayload(entityKey, payload) {
    const author = payload.author?.displayName || '';
    const likes = payload.toolbar?.likeCountNotliked || payload.toolbar?.likeCountLiked || '';
    const pt = payloadText(payload);
    if (!pt.text) return [];
    const hits = [];
    const seenT = new Set();
    for (const cr of pt.runs) {
      const t = cr?.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds;
      if (Number.isFinite(t) && t > 0 && !seenT.has(t)) {
        seenT.add(t);
        hits.push({ time: t, pos: cr.startIndex || 0, len: cr.length || 0 });
      }
    }
    if (!hits.length) return [];
    const afterSegs = buildAfterSegs(pt.text, hits);
    const dedupBase = `${author}|${entityKey}`;
    return hits.map((h, i) => makeEntry(h.time, snippetFor(pt.text, hits, afterSegs, i), pt.text, author, likes, dedupBase));
  }

  function extractNextPage(data) {
    const mutIndex = buildMutationIndex(data);
    const items = collectResponseItems(data);
    let scanned = 0;
    const replyToks = [];
    const seenTok = new Set();
    const parsedPayloads = new Set();   // 已被渲染器形状接住的 payload（兜底扫描跳过，防重复）
    const takeToken = root => {
      const cmd = YTEX.deepFind(root, 'continuationCommand', 10);
      if (cmd?.token && !seenTok.has(cmd.token)) {
        seenTok.add(cmd.token);
        replyToks.push(cmd.token);
      }
    };
    for (const item of items) {
      const thread = item.commentThreadRenderer;
      if (thread) {
        scanned++;
        addEntries(parseThread(thread, mutIndex));
        const p = payloadFor(thread, mutIndex);
        if (p) parsedPayloads.add(p);
        takeToken(thread || item);
        continue;
      }
      if (item.commentRenderer) {
        // 部分回复页的条目直接是 commentRenderer
        scanned++;
        addEntries(parseThread({ comment: { commentRenderer: item.commentRenderer } }, mutIndex));
        continue;
      }
      // 楼中楼新结构：条目本身是 commentViewModel（回复只挂键，正文在 mutations 里）
      if (item.commentViewModel) {
        scanned++;
        addEntries(parseThread({ commentViewModel: item.commentViewModel }, mutIndex));
        const p = payloadFor({ commentViewModel: item.commentViewModel }, mutIndex);
        if (p) parsedPayloads.add(p);
        takeToken(item);
        continue;
      }
      continue;
    }
    // 兜底扫描：本页 mutations 里带时间戳链接、但上述形状都没接住的评论/回复
    // （覆盖楼中楼任意层级的最新结构变体）
    for (const [entityKey, p] of mutIndex) {
      if (parsedPayloads.has(p)) continue;
      if (!p?.properties?.content) continue;
      const list = entriesFromPayload(entityKey, p);
      if (list.length) {
        scanned++;
        addEntries(list);
      }
    }
    // 首页留一份原始结构样本：若最终 0 时间戳，可在控制台导出供精确适配
    if (!debugSample) {
      const firstThread = items.map(i => i.commentThreadRenderer).find(Boolean) || null;
      const muts = (data?.frameworkUpdates?.entityBatchUpdate?.mutations || [])
        .filter(m => m?.payload?.commentEntityPayload).slice(0, 3);
      debugSample = { thread: firstThread, muts };
    }
    return { scanned, replyToks };
  }

  async function runInnertube(myGen) {
    const first = await YTEX.innertube.next({ videoId: getVideoId() });
    if (myGen !== gen) return;
    let token = findCommentsToken(first);
    if (!token) throw new Error('未找到评论 continuation');

    for (let page = 0; page < MAX_PAGES && token && myGen === gen; page++) {
      const data = await YTEX.innertube.next({ continuation: token });
      if (myGen !== gen) return;
      const { scanned, replyToks } = extractNextPage(data);
      scanCount += scanned;
      replyTokens.push(...replyToks);
      if (page === 0 && scanned === 0) throw new Error('接口未返回评论（首页无评论线程）');
      scheduleRender();
      token = findNextToken(data);
      if (token) await sleep(PAGE_DELAY_MS);
    }
    // 顶层扫完后，拉取楼中楼回复（有预算上限，防止爆炸）
    await drainReplies(myGen);
  }

  // 楼中楼回复队列：逐线程拉取（回复页可能自带下一页，同样入队）
  async function drainReplies(myGen) {
    let fetched = 0;
    while (replyTokens.length && fetched < REPLIES_MAX_FETCH && myGen === gen) {
      const tok = replyTokens.shift();
      try {
        const data = await YTEX.innertube.next({ continuation: tok });
        if (myGen !== gen) return;
        const { scanned, replyToks } = extractNextPage(data);
        scanCount += scanned;
        // 回复页末尾的"更多回复"续页 token（楼中楼中楼会再分页）：去重后接着拉
        const next = findNextToken(data);
        if (next && !replyTokens.includes(next) && next !== tok) replyTokens.push(next);
        replyTokens.push(...replyToks.filter(t => t !== next && !replyTokens.includes(t)));
        flush();
      } catch {}
      fetched++;
      if (replyTokens.length && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
    }
  }

  function getVideoId() {
    return videoId;
  }

  // ---------- 兜底：DOM 观察 + 受控滚动 ----------

  // 遍历评论内容 DOM，收集时间戳链接（二级来源）及其在全文中的位置
  function collectAnchorHits(contentEl, seenT) {
    const hits = [];
    let offset = 0;
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          offset += child.textContent.length;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const href = child.getAttribute('href');
          const len = (child.textContent || '').length;
          if (href && href.includes('t=')) {
            const t = YTEX.tParamToSeconds(new URL(href, location.origin).searchParams.get('t'));
            if (t !== null && t > 0 && !seenT.has(t)) {
              seenT.add(t);
              hits.push({ time: t, pos: offset, len });
            }
            offset += len;
          } else {
            walk(child);
          }
        }
      }
    };
    walk(contentEl);
    return hits;
  }

  function scanDom(root, processed) {
    // 顶层线程 + 楼中楼回复（ytd-comment-view-model，含已展开的回复）一并扫描；
    // 同一条评论经两条路径解析时由内容键去重
    const elsToScan = [
      ...YTEX.qa(YTEX.SELECTORS.commentThread, root),
      ...root.querySelectorAll('ytd-comment-view-model'),
    ];
    for (const el of elsToScan) {
      if (processed.has(el)) continue;
      processed.add(el);
      const contentEl = YTEX.q(YTEX.SELECTORS.commentContent, el);
      if (!contentEl) continue;
      const author = (YTEX.q(YTEX.SELECTORS.commentAuthor, el)?.textContent || '').trim();
      const likes = (YTEX.q(YTEX.SELECTORS.commentLikes, el)?.textContent || '').trim();
      const text = contentEl.textContent || '';  // 保留原文（不做 trim），保证位置偏移一致

      const hits = collectAnchorHits(contentEl, new Set());
      const seenT = new Set(hits.map(h => h.time));
      // 三级来源：纯文本正则（同样记录位置）
      for (const m of text.matchAll(YTEX.tsRegex())) {
        const t = YTEX.clockToSeconds(m[0]);
        if (t !== null && t > 0 && !seenT.has(t)) {
          seenT.add(t);
          hits.push({ time: t, pos: m.index, len: m[0].length });
        }
      }
      scanCount++;
      if (!hits.length) continue;
      hits.sort((a, b) => a.pos - b.pos);
      const afterSegs = buildAfterSegs(text, hits);
      addEntries(hits.map((h, i) => makeEntry(h.time, snippetFor(text, hits, afterSegs, i), text, author, likes, `${author}|${text}`)));
    }
  }

  function startDomFallback(myGen) {
    const root = YTEX.q(YTEX.SELECTORS.commentsRoot);
    if (!root) {
      // 评论区可能尚未渲染，稍后重试
      retryTimer = setTimeout(() => { if (myGen === gen) startDomFallback(myGen); }, 1000);
      return;
    }
    const processed = new WeakSet();
    scanDom(root, processed);
    domObserver = new MutationObserver(() => scanDom(root, processed));
    domObserver.observe(root, { childList: true, subtree: true });

    // 全自动滚动加载：无需用户操作。
    // 完成信号 = 顶层"继续加载"指示器消失 且 评论数量连续数拍稳定。
    let steps = 0, stable = 0, lastCount = -1;
    scrollTimer = setInterval(() => {
      if (myGen !== gen) return;
      steps++;
      const count = YTEX.qa(YTEX.SELECTORS.commentThread, root).length;
      scanDom(root, processed);

      const hasMore = !!YTEX.q(YTEX.SELECTORS.commentsContinuation, root);
      stable = (count === lastCount && !hasMore) ? stable + 1 : 0;
      lastCount = count;

      setStatusComments('DOM 解析（{0}）：已扫 {1} 条 · 命中 {2} 个时间戳{3}', fallbackReason, count, entries.length, hasMore ? '' : I(' · 尾部已加载完'));

      if (stable >= DOM_STABLE_LIMIT) {
        clearInterval(scrollTimer);
        scrollTimer = null;
        if (steps > 3) window.scrollTo({ top: 0 }); // 滚完回到顶部，避免把用户留在评论区底部
        renderNow('DOM 解析完成（接口失败：{0}）：{1} 条评论 · {2} 个时间戳', fallbackReason, count, entries.length);
        return;
      }
      if (steps >= DOM_MAX_STEPS) {
        clearInterval(scrollTimer);
        scrollTimer = null;
        renderNow('DOM 解析已达步数上限：{0} 条评论 · {1} 个时间戳', count, entries.length);
        return;
      }

      // 需要更多评论：把评论区往下滚；已在页底但加载器仍在时，轻晃一下触发懒加载
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
      if (atBottom && hasMore) {
        window.scrollBy({ top: -400 });
      } else if (hasMore) {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.85) });
      }
    }, DOM_SCROLL_INTERVAL_MS);
  }

  // ---------- 生命周期 ----------

  async function start(vid) {
    stop();
    videoId = vid;
    fallbackReason = '';
    const myGen = gen;
    // 网络瞬断（Failed to fetch 等）先重试 Innertube 路径——DOM 兜底要全页滚动，能不用就不用
    const TRANSIENT = /failed to fetch|networkerror|net::|timed out|timeout/i;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          resetScanState();
          renderNow('接口请求失败（{0}），重试中（{1}/2）…', lastErr.message, attempt);
          await new Promise(r => setTimeout(r, attempt === 1 ? 2000 : 4000));
          if (myGen !== gen) return;
        }
        await runInnertube(myGen);
        if (myGen !== gen) return;
        if (scanCount === 0) throw new Error('接口未返回评论');
        if (entries.length === 0 && debugSample) {
          console.warn('[YTEX] 扫到评论但未解析出时间戳——请把下面两行结构发给开发者适配：');
          console.warn('[YTEX] thread =', JSON.stringify(debugSample.thread)?.slice(0, 4000));
          console.warn('[YTEX] mutations =', JSON.stringify(debugSample.muts)?.slice(0, 4000));
        }
        renderNow('评论扫描完成：{0} 条评论 · {1} 个时间戳', scanCount, entries.length);
        return;
      } catch (err) {
        if (myGen !== gen) return;
        lastErr = err;
        // 非网络类错误（如"接口未返回评论"）没有重试意义，直接走 DOM 兜底
        if (!TRANSIENT.test(String((err && err.message) || err))) break;
      }
    }
    if (myGen !== gen) return;
    fallbackReason = lastErr ? String(lastErr.message || lastErr) : '';
    console.warn('[YTEX] Innertube 路径失败，转 DOM 全量解析:', lastErr);
    renderNow('接口不可用（{0}），已自动切换 DOM 全量解析…', fallbackReason);
    resetScanState();
    startDomFallback(myGen);
  }

  function resetScanState() {
    entries = [];
    seenKeys = new Set();
    seenContent.clear();
    scanCount = 0;
    debugSample = null;
    replyTokens = [];
  }

  function stop() {
    gen++;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
    if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    resetScanState();
  }

  YTEX.comments = { start, stop, getTimestamps: () => entries.map(e => ({ time: e.time, text: e.text })), refreshStatus };
})();
