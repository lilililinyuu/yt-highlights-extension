// Canvas 折线图（对齐 Highlight Analyzer 风格）：
// 双序列——笑点频率（粉）与总留言频率（蓝），共享刻度，每点圆点标记，
// 横向+纵向浅色网格，底部居中图例，hover 十字线 + 真实计数提示，点击跳转；
// 横轴视口（viewStart/viewEnd）支持缩放：细粒度时以鼠标位置为锚放大，定位密集点；
// 纵轴紧贴数据最高值；颜色取自主题 CSS 变量。
(() => {
  globalThis.YTEX = globalThis.YTEX ?? {};

  function themeColors() {
    let cs = null;
    try {
      const host = document.querySelector('#ytex-panel-host');
      if (host) cs = getComputedStyle(host);
    } catch {}
    const v = n => ((cs && cs.getPropertyValue(n)) || '').trim();
    return {
      laugh: v('--chart-laugh') || '#f06292',
      msg: v('--chart-msg') || '#64a5f0',
      grid: v('--chart-grid') || '#e8e8e8',
      axis: v('--chart-axis') || '#666666',
      pos: v('--chart-pos') || '#e08900',
    };
  }

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
  }

  // 计数语义的降采样：相邻桶按窗口求和
  function downsample(arr, target) {
    if (arr.length <= target) return arr;
    const win = Math.ceil(arr.length / target);
    const out = [];
    for (let i = 0; i < arr.length; i += win) {
      let s = 0;
      for (let j = i; j < Math.min(i + win, arr.length); j++) s += arr[j];
      out.push(s);
    }
    return out;
  }

  // 折线显示开关持久化在模块级（跨 render 保留）：滚轮重算/缩放/调整高度都不重置
  const showLines = { laugh: true, msg: true };

  YTEX.chart = {
    // 渲染并返回交互句柄：
    // hover(i)/setPosition(sec) 重绘；hitTest(x)→数据点序号；timeAt(x)→秒；
    // zoom(factor, anchorSec) 横轴缩放（factor>1 放大）；panRatio(r) 平移；
    // resetView() 复位；view() 当前视口；onViewChange 视口变化回调
    render(canvas, series, { onViewChange } = {}) {
      const dpr = 2;
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 190;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const colors = themeColors();
      const I2 = (k, ...a) => YTEX.i18n.t(k, ...a);
      const bucketSec = series.bucketSec || 10;
      const duration = Math.max(1, series.duration || series.msg.length * bucketSec);
      const msg = downsample(series.msg, 1500);
      const laugh = downsample(series.laugh, 1500);
      const n = Math.max(1, msg.length);
      const secPerPt = (duration / Math.max(1, series.msg.length)) * (series.msg.length / n);
      // 视口横轴时间 → 数据点序号换算
      const secToIdx = sec => sec / secPerPt;
      const idxToSec = i => i * secPerPt;

      const padL = 38, padR = 10, padT = 8, padB = 34;
      const plotW = Math.max(10, w - padL - padR);
      const plotH = Math.max(10, h - padT - padB);

      // 视口状态（秒）
      let viewStart = 0;
      let viewEnd = duration;
      let hoverIdx = null;
      let curPosSec = -1;
      let legendBoxes = [];                            // 图例命中区域（点击检测用）

      const viewSpan = () => Math.max(1, viewEnd - viewStart);
      // 视口内可见的数据点范围
      const visRange = () => {
        const i0 = Math.max(0, Math.floor(secToIdx(viewStart)));
        const i1 = Math.min(n - 1, Math.ceil(secToIdx(viewEnd)));
        return [i0, Math.max(i0, i1)];
      };

      // 纵轴上限：只统计当前显示中的折线（隐藏线不参与，避免顶部空白）
      function maxInView() {
        const [i0, i1] = visRange();
        let m = 1;
        for (let i = i0; i <= i1; i++) {
          if (showLines.msg && msg[i] > m) m = msg[i];
          if (showLines.laugh && laugh[i] > m) m = laugh[i];
        }
        return m;
      }

      // 时间秒 → 画布 x（视口内线性映射）
      const T2X = sec => padL + ((sec - viewStart) / viewSpan()) * plotW;
      const X = i => T2X(idxToSec(i));

      function draw() {
        ctx.clearRect(0, 0, w, h);
        ctx.font = '10px Consolas, Menlo, monospace';
        ctx.lineWidth = 1;

        // 可见区间与纵轴（纵轴随视口内最高值自适应）
        const [i0, i1] = visRange();
        const maxV = maxInView();

        // 水平网格 + y 刻度（共享刻度）
        for (let g = 0; g <= 4; g++) {
          const yy = padT + (g / 4) * plotH;
          ctx.strokeStyle = colors.grid;
          ctx.beginPath();
          ctx.moveTo(padL, yy);
          ctx.lineTo(padL + plotW, yy);
          ctx.stroke();
          ctx.fillStyle = colors.axis;
          ctx.textAlign = 'right';
          ctx.fillText(String(Math.round(maxV * (1 - g / 4))), padL - 5, yy + 3);
        }

        // 垂直网格 + x 时间刻度（6 等分，按视口时间范围）
        for (let g = 0; g <= 6; g++) {
          const xx = padL + (g / 6) * plotW;
          if (g > 0 && g < 6) {
            ctx.strokeStyle = colors.grid;
            ctx.beginPath();
            ctx.moveTo(xx, padT);
            ctx.lineTo(xx, padT + plotH);
            ctx.stroke();
          }
          ctx.fillStyle = colors.axis;
          ctx.textAlign = g === 0 ? 'left' : g === 6 ? 'right' : 'center';
          const lx = g === 6 ? Math.min(w - 2, xx + 24) : xx;
          ctx.fillText(fmt(viewStart + (g / 6) * viewSpan()), lx, padT + plotH + 13);
        }
        ctx.textAlign = 'left';

        // 双折线 + 圆点标记（蓝=留言，粉=笑点；粉线置顶）。
        // 视口放大时点距变大，圆点密度自动跟随可见点数
        const count = i1 - i0 + 1;
        const dotStep = count <= 400 ? 1 : Math.ceil(count / 400);
        const line = (arr, color, width) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          for (let i = i0; i <= i1; i++) {
            const xx = X(i), yy = padT + (1 - arr[i] / maxV) * plotH;
            i === i0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
          }
          // 末桶补一段到区间末尾：桶覆盖 [i*sec,(i+1)*sec)，点画在桶起点，
          // 不补的话粒度越大（桶越宽）曲线尾部缺失越明显
          if (i1 >= n - 1 && arr[n - 1] !== undefined) {
            ctx.lineTo(Math.min(T2X(duration), w - 1), padT + (1 - arr[n - 1] / maxV) * plotH);
          }
          ctx.stroke();
          ctx.fillStyle = color;
          for (let i = i0; i <= i1; i += dotStep) {
            ctx.beginPath();
            ctx.arc(X(i), padT + (1 - arr[i] / maxV) * plotH, 2.4, 0, 7);
            ctx.fill();
          }
        };
        if (showLines.msg) line(msg, colors.msg, 1.4);
        if (showLines.laugh) line(laugh, colors.laugh, 1.6);

        // 当前播放位置指示线（黄色标线 + 顶部三角）
        if (curPosSec >= 0 && curPosSec >= viewStart && curPosSec <= viewEnd) {
          const px = T2X(curPosSec);
          ctx.strokeStyle = colors.pos;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(px, padT - 4);
          ctx.lineTo(px, padT + plotH);
          ctx.stroke();
          ctx.fillStyle = colors.pos;
          ctx.beginPath();
          ctx.moveTo(px - 4, padT - 7);
          ctx.lineTo(px + 4, padT - 7);
          ctx.lineTo(px, padT - 1);
          ctx.closePath();
          ctx.fill();
        }

        // 图例（底部居中，可点击切换对应折线的显示）
        const ly = h - 5;
        ctx.font = '11px sans-serif';
        legendBoxes = [];
        const drawLegend = (key, labelKey, color, cx) => {
          ctx.globalAlpha = showLines[key] ? 1 : 0.3;
          ctx.fillStyle = color;
          ctx.fillRect(cx, ly - 8, 9, 9);
          ctx.fillStyle = colors.axis;
          ctx.textAlign = 'left';
          ctx.fillText(I2(labelKey), cx + 13, ly);
          ctx.globalAlpha = 1;
          legendBoxes.push({ key, x: cx - 4, y: ly - 12, w: 46, h: 16 });
        };
        drawLegend('laugh', '笑点', colors.laugh, w / 2 - 74);
        drawLegend('msg', '留言', colors.msg, w / 2 + 8);

        // hover：十字线 + 强调点 + 提示框
        if (hoverIdx !== null && hoverIdx !== undefined && hoverIdx >= i0 && hoverIdx <= i1) {
          const xx = X(hoverIdx);
          ctx.strokeStyle = colors.axis;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(xx, padT);
          ctx.lineTo(xx, padT + plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          const dot = (cy, color) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(xx, cy, 3.6, 0, 7);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
          };
          if (showLines.laugh) dot(padT + (1 - laugh[hoverIdx] / maxV) * plotH, colors.laugh);
          if (showLines.msg) dot(padT + (1 - msg[hoverIdx] / maxV) * plotH, colors.msg);

          const label = `${fmt(idxToSec(hoverIdx))}  ${I2('留言')} ${msg[hoverIdx]} · ${I2('笑')} ${laugh[hoverIdx]}`;
          ctx.font = '11px Consolas, Menlo, monospace';
          const tw = ctx.measureText(label).width + 12;
          const bx = Math.min(Math.max(padL, xx - tw / 2), w - tw - 2);
          ctx.fillStyle = 'rgba(0, 0, 0, .75)';
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(bx, 2, tw, 18, 5);
          else ctx.rect(bx, 2, tw, 18);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(label, bx + 6, 15);
        }
      }

      draw();

      const self = {
        hitTest(x) {
          if (x < padL || x > padL + plotW) return null;
          const sec = viewStart + ((x - padL) / plotW) * viewSpan();
          return Math.max(0, Math.min(n - 1, Math.round(secToIdx(sec))));
        },
        hover(i) {
          hoverIdx = i;
          draw();
        },
        // 图例命中检测：点击图例切换对应折线显示，返回是否命中
        legendHit(x, y) {
          for (const b of legendBoxes) {
            if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
              showLines[b.key] = !showLines[b.key];
              draw();
              return true;
            }
          }
          return false;
        },
        getShowLines() {
          return { ...showLines };
        },
        // 外部重绘后恢复视口（区间粗细调整时保持横轴不重置）
        setView(v) {
          if (!v) return;
          const span = Math.max(30, Math.min(duration, v.end - v.start));
          viewStart = Math.max(0, Math.min(duration - span, v.start));
          viewEnd = Math.min(duration, viewStart + span);
          draw();
          onViewChange && onViewChange(self.view());
        },
        setPosition(sec) {
          curPosSec = sec;
          draw();
        },
        timeAt(x) {
          if (x < padL || x > padL + plotW) return null;
          return viewStart + ((x - padL) / plotW) * viewSpan();
        },
        // 横轴缩放：factor > 1 放大（窗口变小），anchorSec 为锚点时间（鼠标处）
        zoom(factor, anchorSec) {
          const anchor = anchorSec === undefined
            ? viewStart + viewSpan() / 2
            : Math.max(viewStart, Math.min(viewEnd, anchorSec));
          const ratioL = (anchor - viewStart) / viewSpan();
          const ratioR = (viewEnd - anchor) / viewSpan();
          const newSpan = Math.max(30, Math.min(duration, viewSpan() / factor));
          viewStart = Math.max(0, Math.min(duration - newSpan, anchor - newSpan * ratioL));
          viewEnd = Math.min(duration, viewStart + newSpan);
          if (viewEnd - viewStart < newSpan) viewStart = Math.max(0, viewEnd - newSpan);
          draw();
          onViewChange && onViewChange(self.view());
        },
        // 平移：r>0 右移（时间前进），r 为视口宽度的比例
        panRatio(r) {
          const shift = r * viewSpan();
          viewStart = Math.max(0, Math.min(duration - viewSpan(), viewStart + shift));
          viewEnd = viewStart + viewSpan();
          draw();
          onViewChange && onViewChange(self.view());
        },
        resetView() {
          viewStart = 0;
          viewEnd = duration;
          draw();
          onViewChange && onViewChange(self.view());
        },
        // 将指定时间移到视口中央（区间粗细调整后保持鼠标上下文）
        centerAt(sec) {
          const span = viewSpan();
          viewStart = Math.max(0, Math.min(duration - span, sec - span / 2));
          viewEnd = viewStart + span;
          draw();
          onViewChange && onViewChange(self.view());
        },
        view: () => ({ start: viewStart, end: viewEnd, duration }),
      };
      return self;
    },

    clear(canvas) {
      canvas.width = canvas.clientWidth || 300;
      canvas.height = canvas.clientHeight || 190;
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    },

    // 当前折线显隐（图例点击切换的状态），供视频进度条上的叠加曲线同步
    getLineVisibility: () => ({ laugh: showLines.laugh, msg: showLines.msg }),
  };
})();
