// 工具栏图标点击：通知 YouTube 标签页的内容脚本开合面板（顺带恢复被移除的悬浮球）。
// 非 YouTube 页面时新开 YouTube 首页。
chrome.action.onClicked.addListener(tab => {
  if (!tab || !tab.url || !/^https?:\/\/(www\.)?youtube\.com\//.test(tab.url)) {
    chrome.tabs.create({ url: 'https://www.youtube.com/' });
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'ytexAction' }, () => { void chrome.runtime.lastError; });
});
