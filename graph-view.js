/* graph-view.js
   關係圖快照的唯讀渲染器，/embed（嵌進別人的報導）與 /graph（直接開連結）共用。

   跟主站 app.js 的差別：
   - 位置是快照裡存好的，不跑物理模擬。快照的意義就是「刊出時長這樣」，每次
     打開都重新模擬的話，同一張圖在不同讀者眼中會長得不一樣。
   - 不能展開、不能拖動節點，只能看。點一個節點會標出它的連線，方便讀者看清楚
     某個人連到哪幾間公司。
   - 顏色直接抄主站的 THEMES，嵌進報導裡的圖跟使用者在網站上整理時看到的是同一套。

   快照內容來自使用者建立的資料，雖然伺服器端已經用白名單重組過，這裡的標籤
   一律交給 vis-network 當純文字畫在 canvas 上，不會插進 HTML。 */
(function(global){

  const PALETTES = {
    light: {
      nodeFont: '#10262B',
      nodeShadow: 'rgba(14,140,130,0.18)',
      edgeColor: '#C3D9D5', edgeHighlight: '#C9822E', edgeFont: '#7B928F', edgeFontBg: '#FFFFFF',
      personRegular: { bg: '#BFE3E0', border: '#0E8C82' },
      personCenter:  { bg: '#F0BE73', border: '#9C6520' },
      companyNormal: { bg: '#F2E8D0', border: '#A9824A' },
      companyCenter: { bg: '#F5DCA8', border: '#C9822E' },
      companyFlagged:{ bg: '#F6D9D5', border: '#C23B32' },
      foundationNormal:{ bg: '#EDE7FA', border: '#7A5FC7' },
      foundationCenter:{ bg: '#E3D8FA', border: '#6647B8' },
      cluster:       { bg: '#E8F3F1', border: '#7B928F' },
    },
    dark: {
      nodeFont: '#EAF4F8',
      nodeShadow: 'rgba(63,232,212,0.22)',
      edgeColor: '#2A4A5E', edgeHighlight: '#E0A548', edgeFont: '#7B98A8', edgeFontBg: '#0A1622',
      personRegular: { bg: '#1F5F58', border: '#3FE8D4' },
      personCenter:  { bg: '#E0A548', border: '#B07E2E' },
      companyNormal: { bg: '#16232E', border: '#4A8A93' },
      companyCenter: { bg: '#3A2A0E', border: '#E0A548' },
      companyFlagged:{ bg: '#301A18', border: '#D9534F' },
      foundationNormal:{ bg: '#241A38', border: '#8B6FD9' },
      foundationCenter:{ bg: '#2E2147', border: '#B79AF0' },
      cluster:       { bg: '#101F2E', border: '#5C7A8C' },
    },
  };

  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif';

  function colorOf(c){
    return { background: c.bg, border: c.border, highlight: { background: c.bg, border: c.border }, hover: { background: c.bg, border: c.border } };
  }

  function toVisNode(n, t){
    const base = { id: n.id, label: n.l, x: n.x, y: n.y };
    if(n.k === 'c'){
      const c = n.w ? t.companyFlagged : (n.s ? t.companyCenter : t.companyNormal);
      return Object.assign(base, {
        shape: 'box', margin: 10, borderWidth: (n.s || n.w) ? 3 : 2,
        shapeProperties: { borderRadius: 5, borderDashes: n.d ? [4, 3] : false },
        color: colorOf(c), font: { size: n.s ? 13 : 12, color: t.nodeFont, face: FONT },
      });
    }
    if(n.k === 'f'){
      const c = n.s ? t.foundationCenter : t.foundationNormal;
      return Object.assign(base, {
        shape: 'hexagon', size: n.s ? 26 : 18, borderWidth: n.s ? 3 : 2,
        color: colorOf(c), font: { size: n.s ? 13 : 12, color: t.nodeFont, face: FONT },
      });
    }
    if(n.k === 'g'){
      return Object.assign(base, {
        shape: 'dot', size: 14, color: colorOf(t.cluster), font: { size: 11, color: t.nodeFont, face: FONT },
      });
    }
    const c = n.s ? t.personCenter : t.personRegular;
    return Object.assign(base, {
      shape: 'dot', size: n.s ? 24 : 16, color: colorOf(c), font: { size: n.s ? 15 : 13, color: t.nodeFont, face: FONT },
    });
  }

  /* opts.theme：'light'（預設，大部分新聞網站是白底）或 'dark'
     opts.interactive：可不可以拖曳畫面、縮放。嵌入時要關掉——嵌在文章中間的圖
     如果吃掉滑鼠滾輪，讀者捲文章捲到一半會突然變成在縮放圖，手機上手指一碰到圖
     也會卡住整頁不能捲。要細看的人點「開啟完整圖」去 /graph。 */
  function mount(container, snapshot, opts){
    opts = opts || {};
    const t = PALETTES[opts.theme] || PALETTES.light;
    const data = (snapshot && snapshot.data) || { nodes: [], edges: [] };

    const nodes = new vis.DataSet(data.nodes.map(n => toVisNode(n, t)));
    const edges = new vis.DataSet(data.edges.map((e, i) => ({
      id: 'e' + i, from: e.f, to: e.t, label: e.l || '', dashes: !!e.d,
    })));

    const interactive = !!opts.interactive;
    const network = new vis.Network(container, { nodes, edges }, {
      autoResize: true,
      physics: false,
      interaction: {
        hover: true, tooltipDelay: 150,
        dragNodes: false, dragView: interactive, zoomView: interactive,
        selectConnectedEdges: true,
      },
      nodes: { borderWidth: 2, shadow: { enabled: true, color: t.nodeShadow, size: 10, x: 0, y: 0 } },
      edges: {
        color: { color: t.edgeColor, highlight: t.edgeHighlight, hover: t.edgeHighlight },
        width: 1.2,
        font: { color: t.edgeFont, size: 10, strokeWidth: 5, strokeColor: t.edgeFontBg, align: 'top', face: FONT },
        smooth: { type: 'continuous' },
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
      },
    });

    if(!interactive){
      /* vis-network 預設會把畫布設成「不讓瀏覽器處理觸控捲動」，好讓它自己接手拖曳。
         嵌入時拖曳本來就關了，這樣設定只會讓手機讀者手指一放到圖上就捲不動整篇
         文章。把捲動權還給瀏覽器。 */
      container.querySelectorAll('.vis-network, canvas').forEach(el => { el.style.touchAction = 'pan-x pan-y'; });
    }

    const fit = () => network.fit({ animation: false });
    fit();
    // 報導的版面寬度會隨螢幕改變，iframe 跟著變時要重新縮放，圖才不會被切掉
    if(typeof ResizeObserver !== 'undefined'){
      let timer = null;
      new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(fit, 80); }).observe(container);
    }
    return { network, fit };
  }

  global.UDCGraphView = { mount };

})(window);
