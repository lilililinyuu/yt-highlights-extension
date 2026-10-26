// 边栏样式：以 JS 字符串形式存放，注入 Shadow Root 内的 <style>。
// 浅色为主题默认值，:host(.dark) 覆盖为深色变量；全部颜色走 CSS 变量。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};

  YTEX.PANEL_CSS = `
:host {
  all: initial;
  position: fixed;
  top: 12vh;
  right: 0;
  z-index: 2147483647;
  font: 13px/1.5 Roboto, "Segoe UI", "Microsoft YaHei", sans-serif;
  pointer-events: none;

  /* —— 浅色（默认）—— */
  --bg: #ffffff;
  --bg-2: #f7f7f7;
  --border: #e5e5e5;
  --border-soft: #f0f0f0;
  --text: #0f0f0f;
  --text-2: #5f6368;
  --text-3: #909090;
  --hover: #eef4fb;
  --accent: #065fd4;
  --accent-contrast: #ffffff;
  --accent-weak: rgba(6, 95, 212, .08);
  --accent-weak-2: rgba(6, 95, 212, .18);
  --accent-border: rgba(6, 95, 212, .30);
  --input-bg: #ffffff;
  --input-border: #d9d9d9;
  --detail-g1: rgba(6, 95, 212, .06);
  --detail-g2: rgba(6, 95, 212, .02);
  --detail-text: #1f2933;
  --tab-active-bg: #e3edfb;
  --tab-active-text: #0b57d0;
  --fab-bg: #ffffff;
  --fab-border: #dadce0;
  --fab-color: #065fd4;
  --fab-hover: #f1f3f4;
  --sb-thumb: #c8c8c8;
  --sb-thumb-hover: #a8a8a8;
  --shadow: -8px 0 24px rgba(0, 0, 0, .16);
  --flash: rgba(6, 95, 212, .22);
  --now-bg: rgba(224, 137, 0, .10);
  --now-bar: #e08900;
  --chart-laugh: #f06292;
  --chart-msg: #64a5f0;
  --chart-grid: #ececec;
  --chart-axis: #666666;
  --chart-pos: #e08900;
}
:host(.dark) {
  /* —— 深色 —— */
  --bg: #0f0f0f;
  --bg-2: #181818;
  --border: #272727;
  --border-soft: #1c1c1c;
  --text: #f1f1f1;
  --text-2: #aaaaaa;
  --text-3: #7a7a7a;
  --hover: #1d242e;
  --accent: #3ea6ff;
  --accent-contrast: #00224f;
  --accent-weak: rgba(62, 166, 255, .12);
  --accent-weak-2: rgba(62, 166, 255, .28);
  --accent-border: rgba(62, 166, 255, .25);
  --input-bg: #1c1c1c;
  --input-border: #333333;
  --detail-g1: rgba(62, 166, 255, .10);
  --detail-g2: rgba(62, 166, 255, .03);
  --detail-text: #dbe6f2;
  --tab-active-bg: #2b3440;
  --tab-active-text: #ffffff;
  --fab-bg: #0f0f0f;
  --fab-border: #3f3f3f;
  --fab-color: #3ea6ff;
  --fab-hover: #1f1f1f;
  --sb-thumb: #333333;
  --sb-thumb-hover: #474747;
  --shadow: -8px 0 24px rgba(0, 0, 0, .45);
  --flash: rgba(62, 166, 255, .40);
  --now-bg: rgba(255, 215, 94, .13);
  --now-bar: #ffd75e;
  --chart-laugh: #ff7aa2;
  --chart-msg: #6fb1ff;
  --chart-grid: #2b2b2b;
  --chart-axis: #aaaaaa;
  --chart-pos: #ffd75e;
}

:host(.hidden) .fab, :host(.hidden) .panel { display: none !important; }

.fab {
  pointer-events: auto;
  position: fixed;
  top: 12vh;
  right: 14px;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--fab-bg);
  border: 1px solid var(--fab-border);
  color: var(--fab-color);
  font-size: 19px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .22);
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  user-select: none;
}
.fab.dragging { cursor: grabbing; }
.fab:hover { background: var(--fab-hover); }
/* 悬停悬浮球时右上角浮现的小 × ：点击移除悬浮球（工具栏图标可恢复） */
.fab-close {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(20, 20, 20, .88);
  color: #fff;
  font-size: 12px;
  line-height: 15px;
  text-align: center;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity .15s;
}
.fab:hover .fab-close { opacity: 1; pointer-events: auto; }
.fab-close:hover { background: rgba(216, 62, 62, .95); }
:host(.open) .fab { display: none; }

.panel {
  pointer-events: auto;
  display: none;
  position: fixed;
  top: 12vh;
  right: 0;
  width: 340px;
  height: 72vh;
  min-width: 280px;
  max-width: 60vw;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-right: none;
  border-radius: 12px 0 0 12px;
  box-shadow: var(--shadow);
  flex-direction: column;
  overflow: hidden;
}
/* 自由模式：解除右侧吸附，圆角四侧完整 */
.panel.panel-free {
  border-radius: 12px;
  border-right: 1px solid var(--border);
}
/* 底部高度拖拽手柄（吸附与自由模式通用） */
#ytex-ht-grip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 10px;
  cursor: ns-resize;
  z-index: 60;
}
#ytex-ht-grip:hover { background: rgba(128, 128, 128, .25); }
/* 锁定：禁用拖动手柄与 header 拖动 */
:host(.panel-locked) #ytex-ht-grip { display: none; }
.panel-locked #ytex-ht-grip { display: none; }
:host(.open) .panel { display: flex; }

.resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 7px;
  cursor: ew-resize;
  z-index: 5;
}
.resize-handle:hover { background: var(--accent-weak-2); }

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  cursor: ns-resize;
  flex: none;
}
.logo { font-size: 15px; }
.tabs { display: flex; gap: 2px; flex: 1; }
.tab {
  padding: 4px 11px;
  border-radius: 14px;
  cursor: pointer;
  color: var(--text-2);
  font-size: 12px;
  white-space: nowrap;
}
.tab:hover { color: var(--text); }
.tab.active { background: var(--tab-active-bg); color: var(--tab-active-text); }
.min {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-2);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.min:hover { background: var(--hover); color: var(--text); }

.body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--sb-thumb) transparent;
}
.body::-webkit-scrollbar { width: 8px; }
.body::-webkit-scrollbar-thumb { background: var(--sb-thumb); border-radius: 4px; }
.body::-webkit-scrollbar-thumb:hover { background: var(--sb-thumb-hover); }

.sec { display: none; }
.sec.active { display: block; }
.empty { padding: 28px 18px; color: var(--text-3); text-align: center; }

.row {
  display: flex;
  gap: 9px;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-soft);
  align-items: flex-start;
  transition: background .12s ease;
}
.row:hover { background: var(--hover); }
/* 当前位置行：距视频播放位置最近的时间戳（琥珀色，与图表位置指示线同色系） */
.row.now {
  background: var(--now-bg);
  box-shadow: inset 2px 0 0 var(--now-bar);
}
.row.now:hover { background: var(--now-bg); filter: brightness(.97); }
.row.now .t {
  background: var(--now-bar);
  color: var(--accent-contrast);
  font-weight: 600;
}
.row .t {
  flex: none;
  font-family: Consolas, Menlo, monospace;
  color: var(--accent);
  font-size: 12px;
  padding: 1px 6px;
  background: var(--accent-weak);
  border-radius: 4px;
  white-space: nowrap;
}
.row .main { flex: 1; min-width: 0; }
.row .txt {
  white-space: pre-line;          /* 保留原评论换行，超长自动折行 */
  word-break: break-word;
  user-select: text;
}
.row .meta { color: var(--text-3); font-size: 11px; margin-top: 2px; }
.row.flash { animation: ytex-flash 1.2s ease; }
@keyframes ytex-flash {
  0% { background: var(--flash); }
  100% { background: transparent; }
}

.row .more {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 7px;
  border-radius: 4px;
  white-space: nowrap;
}
.row .more:hover { background: var(--hover); color: var(--text); }
.more.on { color: var(--accent); background: var(--accent-weak); }

.detail {
  background: linear-gradient(180deg, var(--detail-g1), var(--detail-g2));
  border-bottom: 1px solid var(--border-soft);
  border-left: 3px solid var(--accent);
  padding: 9px 12px 10px 9px;
  /* 限高 + 框内滚动：长评论不撑开面板，展开时自动滚到对应时间戳行 */
  max-height: 260px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--sb-thumb) transparent;
}
.detail-text {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--detail-text);
  font-size: 12px;
  line-height: 1.7;
  max-height: 200px;
  overflow-y: auto;
  user-select: text;
  scrollbar-width: thin;
  scrollbar-color: var(--sb-thumb) transparent;
}
.detail-text::-webkit-scrollbar { width: 6px; }
.detail-text::-webkit-scrollbar-thumb { background: var(--sb-thumb); border-radius: 3px; }
.detail-text .chip {
  margin: 0 1px;
  border: 1px solid var(--accent-border);
}
.chip {
  border: none;
  background: var(--accent-weak);
  color: var(--accent);
  font-family: Consolas, Menlo, monospace;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  cursor: pointer;
}
.chip:hover { background: var(--accent-weak-2); }
.chip.active {
  background: var(--accent);
  color: var(--accent-contrast);
  font-weight: 700;
  box-shadow: 0 0 0 2px var(--accent-weak-2);
}

.chart-wrap { padding: 12px; }
canvas.chart-canvas { width: 100%; display: block; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; }
.chart-grip {
  height: 10px;
  margin: 2px auto 0;
  width: 44px;
  border-radius: 5px;
  background: var(--input-border);
  cursor: ns-resize;
}
.chart-grip:hover { background: var(--text-3); }
.chart-scroll {
  position: relative;
  height: 10px;
  margin: 4px 0 0;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 5px;
  cursor: pointer;
}
.chart-scroll-thumb {
  position: absolute;
  top: 1px;
  bottom: 1px;
  min-width: 10px;
  border-radius: 4px;
  background: var(--accent);
  opacity: .55;
  cursor: grab;
}
.chart-scroll-thumb:hover { opacity: .8; }
.chart-note { color: var(--text-3); font-size: 11px; margin-top: 8px; }

.emotes { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 0 12px 12px; }
.emotes-label { color: var(--text-3); font-size: 11px; }
.emote {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  cursor: pointer;
}
.emote:hover { border-color: var(--text-3); color: var(--text); }
.emote.on { border-color: var(--accent); color: var(--accent); background: var(--accent-weak); }
.emote-img { width: 16px; height: 16px; vertical-align: -3px; margin-right: 2px; }

.setting-block { padding: 12px 14px; border-bottom: 1px solid var(--border-soft); }
.setting-block h4 { margin: 0 0 8px; font-size: 12px; color: var(--text-2); font-weight: 600; }

.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.seg-btn {
  border: none;
  background: transparent;
  color: var(--text-2);
  padding: 5px 16px;
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.seg-btn + .seg-btn { border-left: 1px solid var(--border); }
.seg-btn:hover { background: var(--hover); }
.seg-btn.active { background: var(--accent-weak); color: var(--accent); font-weight: 600; }

/* 笑点曲线 Tab 底部：采集开关与聊天缓存清除 */
.chart-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 12px 10px;
}

.btn {
  background: var(--accent);
  border: none;
  color: var(--accent-contrast);
  font-weight: 600;
  height: 28px;
  box-sizing: border-box;
  padding: 0 14px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  font-size: 12px;
  /* 文字上下左右严格居中：不依赖继承行高（否则上/下留白不等） */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.btn:hover { filter: brightness(1.1); }
.btn.ghost { background: transparent; border: 1px solid var(--input-border); color: var(--text-2); font-weight: 400; }
.btn.ghost:hover { border-color: var(--text-3); color: var(--text); }
.kw-area {
  display: block;
  box-sizing: border-box;
  width: 100%;
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  padding: 6px 8px;
  outline: none;
  font: 12px/1.6 Consolas, Menlo, monospace;
  resize: vertical;
}
.kw-area:focus { border-color: var(--accent); }
.kw-btns { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 0 12px; box-sizing: border-box; }
/* 设置区块内（发笑关键词）：去掉额外内边距，按钮行与上方输入框左右边框对齐 */
.setting-block .kw-btns { padding: 0; }
.setting-line { color: var(--text-3); font-size: 11px; flex: 1; }
.bucket-sel {
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  height: 28px;
  box-sizing: border-box;
  padding: 0 8px;
  font-size: 12px;
  outline: none;
}
.ai-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
/* 多行输入行（自定义要求）：标签与输入框顶部对齐 */
.ai-row.ai-row-top { align-items: flex-start; }
.ai-row.ai-row-top .ai-label { line-height: 26px; }
.ai-label { flex: none; width: 74px; color: var(--text-2); font-size: 12px; }
.ai-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  box-sizing: border-box;
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  padding: 0 8px;
  outline: none;
  font-size: 12px;
}
.ai-input:focus { border-color: var(--accent); }
/* 自定义要求多行输入（与单行框同款字号/内边距，高度=两行） */
.ai-extra {
  flex: 1;
  min-width: 0;
  min-height: 56px;
  resize: vertical;
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  padding: 4px 8px;
  outline: none;
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.ai-extra:focus { border-color: var(--accent); }
/* 字幕下载行：与标题同左缘（不叠加区块内边距），剩余空间由按钮均分 */
.subs-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 2px 0 4px; }
.subs-row select { flex: 0 1 auto; min-width: 0; max-width: 65%; }
.subs-row .btn { flex: none; }
/* 手动标记表情只读列表（设置区，可滚动防止撑开面板） */
.kw-emote-list {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--bg-2);
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-2);
  max-height: 88px;
  overflow: auto;
  word-break: break-all;
  line-height: 1.7;
}
/* 追问区：会话列表 + 输入行 */
.ai-follow { margin: 0 12px 8px; }
.ai-follow-list {
  border: 1px dashed var(--input-border);
  border-radius: 8px;
  background: var(--bg-2);
  max-height: 220px;
  overflow-y: auto;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.7;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text);
  user-select: text;
}
.ai-follow-msg { display: flex; gap: 6px; align-items: flex-start; word-break: break-word; }
.ai-follow-msg.user { background: var(--accent-weak); border-radius: 6px; padding: 4px 8px; }
.ai-follow-tag { flex: none; font-weight: 600; color: var(--text-2); }
.ai-follow-body { flex: 1; min-width: 0; white-space: pre-wrap; }
.ai-follow .ai-row { margin-top: 6px; margin-bottom: 0; }

/* 手动标记表情徽章（图片 + 名称）：固定尺寸，大小统一 */
.emote-mark-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 2px 6px 2px 0;
  padding: 3px 8px;
  min-height: 28px;
  box-sizing: border-box;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  white-space: nowrap;
}
.emote-mark-chip .emote-img { width: 20px; height: 20px; object-fit: contain; margin: 0; vertical-align: middle; }
/* Noto 标准 emoji 直接用字符渲染 */
.emote-char { font-size: 18px; line-height: 1; }
.emote-mark-chip .emote-char { font-size: 18px; }
/* 展开全文后定位到的时间戳高亮 */
.chip.chip-focus,
.notes-ts.chip-focus {
  outline: 2px solid var(--accent);
  background: var(--accent-weak-2);
}
/* 表情标记列表的展开/收起按钮 */
.emote-more { color: var(--accent); font-weight: 600; }
/* 时间轴叠加设置行（笑点曲线 Tab 底部）：开关独占一行，两个透明度各占一行 */
.overlay-set {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 10px;
  align-items: center;
  padding: 6px 12px 10px;
  font-size: 12px;
  color: var(--text-2);
}
.overlay-toggle-wrap { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; }
.overlay-set label { cursor: pointer; user-select: none; }
.overlay-set input[type="checkbox"] { margin: 0; cursor: pointer; }
.overlay-set input[type="range"] { width: 100%; margin: 0; cursor: pointer; accent-color: var(--accent); }
/* 滑杆标签：左对齐 + 固定列宽，各行滑杆起点对齐（与勾选行同一左缘） */
.overlay-op-label { text-align: left; min-width: 76px; white-space: nowrap; }
/* 设置 Tab 里嵌套使用的同一网格：去掉重复内边距，勾选行/按钮行与滑杆行距一致 */
.setting-block .overlay-set { padding: 6px 0 0; }
.setting-block > .overlay-toggle-wrap { margin: 3px 0; }
/* 缓存状态行（恢复/已缓存提示） */
.ai-meta {
  margin: 0 12px 4px;
  color: var(--text-3);
  font-size: 11px;
}
.ai-output {
  margin: 0 12px 10px;
  border: 1px dashed var(--input-border);
  border-radius: 8px;
  background: var(--bg-2);
  max-height: 300px;
  overflow: auto;
  padding: 8px 10px;
  font: 12px/1.9 Consolas, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  color: var(--text);
}

.notes-toolbar { display: flex; gap: 6px; padding: 10px 12px 6px; flex-wrap: wrap; }
.notes-toolbar .btn { padding: 5px 10px; font-size: 12px; font-weight: 400; }
.notes-area {
  display: block;
  box-sizing: border-box;
  width: calc(100% - 24px);
  margin: 0 12px 8px;
  min-height: 230px;
  height: 280px;
  resize: vertical;
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--input-border);
  border-radius: 8px;
  padding: 8px;
  outline: none;
  font: 12px/1.8 Consolas, Menlo, monospace;
  white-space: pre;
  overflow: auto;
  user-select: text;
}
.notes-area:focus { border-color: var(--accent); }
.ts-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-soft);
  font-size: 11px;
  color: var(--text-2);
  /* 吸顶：滚动列表时工具条固定在面板顶部 */
  position: sticky;
  top: 0;
  z-index: 4;
  background: var(--bg);
}
.ts-toolbar .push { margin-left: auto; }
.ts-toolbar .btn { padding: 3px 8px; }
.ts-toolbar .ts-count { flex: 1; }
.ts-toolbar input[type="checkbox"] { accent-color: var(--accent); cursor: pointer; }
.row-check { flex: none; margin: 0; cursor: pointer; accent-color: var(--accent); align-self: center; }
.notes-hint { padding: 0 12px 10px; color: var(--text-3); font-size: 11px; }
.marker-input {
  width: 110px;
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  padding: 5px 8px;
  outline: none;
  font-size: 13px;
}
.marker-input:focus { border-color: var(--accent); }
.toggle-on { color: var(--accent) !important; background: var(--accent-weak) !important; }
.notes-preview {
  margin: 0 12px 8px;
  border: 1px dashed var(--input-border);
  border-radius: 8px;
  background: var(--bg-2);
  max-height: 220px;
  overflow: auto;
  padding: 6px 8px;
  font: 12px/1.9 Consolas, Menlo, monospace;
  user-select: text;
}
.notes-preview-row { white-space: pre-wrap; word-break: break-word; min-height: 1.5em; color: var(--text); }
.notes-ts {
  border: none;
  background: var(--accent-weak);
  color: var(--accent);
  font-family: Consolas, Menlo, monospace;
  font-size: 11px;
  padding: 0 5px;
  border-radius: 4px;
  cursor: pointer;
  margin: 0 1px;
}
.notes-ts:hover { background: var(--accent-weak-2); }
.notes-adj {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-3);
  font-size: 10px;
  border-radius: 4px;
  padding: 0 4px;
  cursor: pointer;
  margin-left: 3px;
}
.notes-adj:hover { color: var(--text); border-color: var(--text-3); }

.footer {
  flex: none;
  display: block;
  padding: 5px 12px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
  border-top: 1px solid var(--border);
  background: var(--bg-2);
}
/* 状态文字允许换行完整显示 */
.footer .status { display: block; word-break: break-word; }
.footer .status:empty { display: none; }
`;
})();
