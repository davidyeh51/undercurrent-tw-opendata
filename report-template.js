/* report-template.js
   商業模式報告的共用渲染引擎。輸入是後端（Claude API）回傳、符合固定
   schema 的 JSON，輸出是一份完整、獨立的 HTML 字串（含自己的
   <style>），可以直接當 iframe 的 srcdoc，也可以是 report.html
   單獨載入的內容。骨架（米綠底、深綠/赭色配色）
   沿用「健行筆記」那份報告定案的樣式。章節結構底下走的是「界定問題／
   建立假設／事實檢驗／提出解法」四步驟，但顯示出來的標題刻意寫成白話
   （先看懂這門生意／幾個可能的答案／事實查證／結論與建議）——方法論
   是給生成端遵循的，讀者只需要知道每一節在回答什麼。

   注意：report 的文字內容來自 LLM 根據網路搜尋整理的結果，屬於不可
   信任的輸入（有可能包含惡意 HTML/腳本，不管是 LLM 自己產生的還是
   間接被搜尋結果 prompt injection 出來的）——這裡每一個欄位在組進
   HTML 字串之前都一定要先跳脫，不能直接 innerHTML/字串插入。 */
(function(global){

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 跳脫之後才處理 **粗體**，所以使用者輸入的 <script> 等字串一定會先被拆解掉，
  // 這裡只是在乾淨的文字上加一層 <b>，不會重新打開任何注入面。
  function mdBold(s){
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }

  /* 判定用「成立／部分成立／不成立」而不是「支持／不支持」：這一節檢驗的是
     第 02 節列出的「答案」，讀起來是「答案 1 · 部分成立」，比「答案 1 · 部分
     支持」直接——支持什麼？讀者還得自己補主詞。 */
  /* 來源網址只接受 http(s)。

     esc() 只處理 HTML 特殊字元，擋不住 javascript: 這種網址——href="javascript:..."
     在跳脫之後仍然是一個能執行程式的連結。報告內容是 AI 讀了網路搜尋結果寫的，
     搜尋結果裡可能藏著刻意引導 AI 輸出這種網址的文字（prompt injection）。
     不是 http(s) 的一律不做成連結，只顯示文字。 */
  function safeHttpUrl(u){
    try{
      const url = new URL(String(u || '').trim());
      return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
    } catch(err){
      return null;
    }
  }

  function verdictTag(v){
    if(v === 'yes') return '<span class="tag yes">成立</span>';
    if(v === 'no') return '<span class="tag no">不成立</span>';
    return '<span class="tag mid">部分成立</span>';
  }

  /* 模型給的卡片標籤常常只是內部編號（「H1」「H2」「子問題一」），對讀者
     完全沒有意義——H 是 hypothesis 的縮寫，一般人看不懂，而且全篇沒有任何
     地方回頭引用它。這裡把編號剝掉，剩下的如果還有字（例如「H1 收入不靠
     唱片」的「收入不靠唱片」）就當成卡片的短標題，沒有就不顯示。編號改由
     版面自己給（問題 1、答案 1），讓 01 跟 02 用同一個序號對得起來。 */
  function cardTitle(label){
    return String(label == null ? '' : label)
      .replace(/^\s*H\s*\d+\s*[:：.、\-–—]?\s*/i, '')
      .replace(/^\s*(子問題|問題|假設|答案)\s*[一二三四五六七八九十\d]+\s*[:：.、\-–—]?\s*/, '')
      .trim();
  }

  // 第 03 節每一段檢驗的是哪個答案：fact_hypo_refs 是「H2」這種字串，取出數字
  function answerNumber(ref){
    const m = String(ref || '').match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
  function seriesColor(slot){
    const i = Math.max(1, Math.min(5, Number(slot) || 1)) - 1;
    return SERIES[i];
  }

  /* ---------------------------------------------------------
     SVG 文字沒有內建自動換行——AI 產出的敘述長度不保證跟 prompt
     裡要求的字數一致，超過方框寬度會直接整行溢出、疊到旁邊的節點
     上（跑版）。這裡用字元寬度估算（全形字視為 1 個單位，半形視為
     0.55 個單位，中文內容為主的情況下夠準）手動換行，方框高度也
     跟著實際換行後的行數算，不是固定值——項目內容變長，方框自己
     長高，不會裁切或互相重疊。
  --------------------------------------------------------- */
  function charUnits(ch){
    const code = ch.codePointAt(0);
    return code > 0x2E80 ? 1 : 0.55; // 粗略區分全形／半形
  }
  function strUnits(s){
    return Array.from(s).reduce((sum, c) => sum + charUnits(c), 0);
  }

  /* 斷行的單位是「字」，但半形英數要整串一起搬。原本是逐字元斷，會出現
     「⋯銷往全球 1 ／ 20+國家」這種把數字從中間切開的行。

     全形字各自是一個 token，連續的半形字（英文單字、數字、+ . - 等）合成
     一個 token，空白自己是一個 token——空白是可以斷的地方，斷掉之後就丟掉
     不要留在下一行的行首。 */
  function tokenize(str){
    const out = [];
    let buf = '';
    for(const ch of Array.from(str)){
      if(charUnits(ch) === 1 || ch === ' '){
        if(buf){ out.push(buf); buf = ''; }
        out.push(ch);
      } else {
        buf += ch;
      }
    }
    if(buf) out.push(buf);
    return out;
  }

  function wrapText(str, maxUnits, maxLines){
    const raw = String(str || '').trim();
    if(!raw) return [];

    // 單一 token 比一整行還寬（例如很長的網址）就只能硬切，否則會溢出方框
    const tokens = [];
    for(const tk of tokenize(raw)){
      if(strUnits(tk) <= maxUnits){ tokens.push(tk); continue; }
      let piece = '';
      for(const ch of Array.from(tk)){
        if(piece && strUnits(piece + ch) > maxUnits){ tokens.push(piece); piece = ch; }
        else piece += ch;
      }
      if(piece) tokens.push(piece);
    }

    const lines = [];
    let cur = '', width = 0, hasRest = false;
    for(const tk of tokens){
      const w = strUnits(tk);
      if(width + w > maxUnits && cur){
        // 已經是最後一行了，後面的東西放不下——記下來，等一下補省略號
        if(lines.length + 1 >= maxLines){ hasRest = true; break; }
        lines.push(cur);
        if(tk === ' '){ cur = ''; width = 0; }
        else { cur = tk; width = w; }
      } else {
        cur += tk; width += w;
      }
    }
    if(cur) lines.push(cur);
    // 在空白處斷行時，前一行會留下一個看不見但仍佔寬度的行尾空白
    for(let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\s+$/, '');
    // 省略號只加在「真的還有內容沒畫進去」的時候，完整畫完就不加
    if(hasRest && lines.length){
      const last = lines[lines.length - 1];
      if(last.length > 1) lines[lines.length - 1] = last.slice(0, -1) + '…';
    }
    return lines;
  }

  /* 把一組「段落規格」（每段自己的字級/顏色/換行寬度）畫成一疊由上
     往下排列的 <text> 行，回傳畫好的 SVG 片段跟總高度，讓呼叫端可以
     用實際高度去算方框大小，而不是用猜的固定值。

     SVG 的 <text y> 是「基線」的位置，不是字的頂端。

     原本每一行都先往下推一整個行高再畫，包括第一行——所以第一行的基線落
     在 startY + 行高，字的頂端離 startY 還有「行高 − 字高」那麼遠。這段
     空白疊在 padTop 上面，實測每個方框上方約 35px、下方只有 14px，看起來
     像文字往下沉了一截。

     改成：第一行只往下推到基線（0.88 個字級，也就是字的上緣剛好貼齊
     startY），之後每一行才推一整個行高；最後再把最後一行基線以下的部分
     （0.12 個字級）算進高度裡。這兩個比例是用中文字實測調出來的——中文字
     幾乎填滿整個字框，跟英文的上伸／下伸比例不一樣，照英文的 0.8／0.22
     算，會變成上面 15px、下面 20px，反過來歪。

     這樣 startY 就是字的上緣、endY 就是字的下緣，呼叫端的 padTop／
     padBottom 才會是眼睛看到的真正留白。 */
  function stackLines(parts, x, startY, textAnchor){
    let svg = '';
    let y = startY;
    let first = true;
    let lastFontSize = 0;
    for(const part of parts){
      const wrapped = wrapText(part.text, part.maxUnits, part.maxLines || 3);
      if(wrapped.length === 0) continue;
      if(part.gapBefore && !first) y += part.gapBefore;
      for(const line of wrapped){
        y += first ? part.fontSize * 0.88 : part.lineHeight;
        first = false;
        svg += `<text x="${x}" y="${y}" font-size="${part.fontSize}" font-weight="${part.weight || 400}" fill="${part.color}"${part.opacity != null ? ` fill-opacity="${part.opacity}"` : ''}${textAnchor ? ` text-anchor="${textAnchor}"` : ''}>${esc(line)}</text>`;
      }
      lastFontSize = part.fontSize;
    }
    return { svg, endY: first ? startY : y + lastFontSize * 0.12 };
  }

  /* ---------------------------------------------------------
     商業模式全景圖：left(inputs) -> center -> right(outputs)，
     下方可選 network（人脈／資本背書）。自動依項目數量與換行後的
     實際行數排版，不手動硬編座標，避免項目數或文字長度變動時
     互相重疊。
  --------------------------------------------------------- */
  function buildDiagramSVG(diagram){
    const inputs = Array.isArray(diagram.inputs) ? diagram.inputs.slice(0, 3) : [];
    const outputs = Array.isArray(diagram.outputs) ? diagram.outputs.slice(0, 5) : [];
    const hasNetwork = !!diagram.has_network && diagram.network && (diagram.network.title || (diagram.network.lines || []).length);

    /* 字級與方框寬度是綁在一起的：SVG 沒有自動換行，wrapText() 是用
       「一行幾個全形字」（maxUnits）估算的，而 maxUnits × fontSize 就
       等於這行實際佔的寬度，必須塞得進方框的內距之內。

       原本最小的說明文字是 11，加上圖框只有約 762px 寬（見下面 CSS 裡
       .wide-figure 的說明），螢幕上實際只剩 8.4px——內文是 16px，圖裡的
       字不到正文的一半，讀者要瞇著眼睛看。兩邊一起修：CSS 讓圖跳出文字
       欄寬（縮放比從 0.76 拉到 1.16），這裡把每一級字往上調（最小
       11→13、標題 15→17）。字級調大就要有地方放，所以方框跟著加寬、
       外距從 40 收到 24——maxUnits 也要同步下修，否則文字會撐出框外。 */
    const VIEW_W = 1000;
    const boxW = 252, gap = 30, margin = 24, padX = 18, padTop = 20, padBottom = 20;
    const centerW = 264, centerPad = 20;
    const rightW = 286, rightPadX = 16;

    // 每個方框的內容都「先量後畫」：用同一組 stackLines() 算出文字
    // 疊起來的實際高度，方框高度 = 內容高度 + 上下留白，寬度固定、
    // 高度看內容多寡自己伸縮。
    function measureInput(b){
      const parts = [
        { text: b.title, fontSize: 17, weight: 700, color: 'currentColor', maxUnits: 12, maxLines: 2, lineHeight: 23 },
      ];
      for(const line of (b.lines || [])){
        parts.push({ text: line, fontSize: 14, color: 'currentColor', opacity: 0.72, maxUnits: 15, maxLines: 2, lineHeight: 20, gapBefore: parts.length === 1 ? 5 : 0 });
      }
      if(b.status){
        parts.push({ text: b.status, fontSize: 13, weight: 700, color: 'var(--accent)', maxUnits: 16, maxLines: 1, lineHeight: 20, gapBefore: 7 });
      }
      return parts;
    }
    function measureOutput(b, color){
      return [
        { text: b.title, fontSize: 16, weight: 700, color: 'currentColor', maxUnits: 15, maxLines: 2, lineHeight: 22 },
        { text: b.value, fontSize: 19, weight: 700, color, maxUnits: 13, maxLines: 1, lineHeight: 25, gapBefore: 5 },
        { text: b.desc, fontSize: 13, color: 'currentColor', opacity: 0.65, maxUnits: 19, maxLines: 2, lineHeight: 19, gapBefore: 5 },
      ];
    }

    const leftParts = inputs.map(measureInput);
    const rightParts = outputs.map((b, i) => measureOutput(b, seriesColor(i + 1)));

    function contentHeight(parts){
      const { endY } = stackLines(parts, 0, 0, null);
      return endY;
    }

    const leftBoxes = leftParts.map(parts => ({ h: Math.max(72, padTop + contentHeight(parts) + padBottom) }));
    const rightBoxes = rightParts.map(parts => ({ h: Math.max(72, padTop + contentHeight(parts) + padBottom) }));

    const leftTotal = leftBoxes.reduce((s, b) => s + b.h, 0) + gap * Math.max(0, leftBoxes.length - 1);
    const rightTotal = rightBoxes.reduce((s, b) => s + b.h, 0) + gap * Math.max(0, rightBoxes.length - 1);

    const centerParts = [
      { text: diagram.center && diagram.center.title, fontSize: 18, weight: 700, color: 'var(--accent-ink)', maxUnits: 12, maxLines: 2, lineHeight: 25 },
      ...((diagram.center && diagram.center.lines) || []).map((line, i) => ({
        text: line, fontSize: 14, color: 'currentColor', opacity: 0.8, maxUnits: 15, maxLines: 2, lineHeight: 21, gapBefore: i === 0 ? 7 : 0,
      })),
    ];
    const centerFlag = diagram.center && diagram.center.flag;
    const centerContentH = contentHeight(centerParts) + (centerFlag ? 23 : 0);
    const centerH = Math.max(96, padTop + centerContentH + padBottom);

    const bodyH = Math.max(leftTotal, rightTotal, centerH) + margin * 2;

    function layout(boxes){
      const total = boxes.reduce((s, b) => s + b.h, 0) + gap * Math.max(0, boxes.length - 1);
      let y = (bodyH - total) / 2;
      const out = [];
      for(const b of boxes){
        out.push({ ...b, y });
        y += b.h + gap;
      }
      return out;
    }

    const leftLaid = layout(leftBoxes);
    const rightLaid = layout(rightBoxes);
    const centerY = (bodyH - centerH) / 2;
    const centerX = (VIEW_W - centerW) / 2;
    const rightX = VIEW_W - margin - rightW;

    // network 方框寬度也跟著內容量，不是死板的 340px
    let networkParts = [];
    let networkH = 0;
    if(hasNetwork){
      networkParts = [
        { text: diagram.network.title, fontSize: 16, weight: 700, color: 'var(--gold, var(--clay))', maxUnits: 18, maxLines: 1, lineHeight: 22 },
        ...(diagram.network.lines || []).map(line => ({ text: line, fontSize: 13, color: 'var(--gold, var(--clay))', maxUnits: 23, maxLines: 2, lineHeight: 19, gapBefore: 4 })),
      ];
      networkH = Math.max(64, padTop + contentHeight(networkParts) + padBottom);
    }
    const VIEW_H = bodyH + (hasNetwork ? networkH + 30 : 0);

    let svg = `<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="商業模式全景圖：免費或低成本的入口把使用者導入中心公司，再由中心公司向右側的收入來源變現">`;
    svg += `<defs><marker id="udcArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`;
    svg += `<g font-family="var(--font-body)">`;

    // 左側輸入
    leftLaid.forEach((b, i) => {
      svg += `<rect x="${margin}" y="${b.y}" width="${boxW}" height="${b.h}" rx="9" fill="none" stroke="currentColor" stroke-opacity="0.35"/>`;
      svg += stackLines(leftParts[i], margin + padX, b.y + padTop, null).svg;
      const midY = b.y + b.h / 2;
      svg += `<path d="M${margin + boxW},${midY} C ${centerX - 40},${midY} ${centerX - 40},${centerY + centerH / 2} ${centerX},${centerY + centerH / 2}" fill="none" stroke="currentColor" stroke-opacity="0.45" marker-end="url(#udcArrow)"/>`;
    });

    // 中心節點
    svg += `<rect x="${centerX}" y="${centerY}" width="${centerW}" height="${centerH}" rx="11" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/>`;
    const centerDrawn = stackLines(centerParts, centerX + centerW / 2, centerY + padTop, 'middle');
    svg += centerDrawn.svg;
    if(centerFlag){
      svg += `<text x="${centerX + centerW / 2}" y="${centerY + centerH - padBottom - 3}" font-size="13" fill="var(--clay)" font-weight="700" text-anchor="middle">${esc(centerFlag)}</text>`;
    }

    // 右側輸出
    rightLaid.forEach((b, i) => {
      const color = seriesColor(i + 1);
      svg += `<rect x="${rightX}" y="${b.y}" width="${rightW}" height="${b.h}" rx="9" fill="none" stroke="${color}" stroke-width="1.5"/>`;
      svg += stackLines(rightParts[i], rightX + rightPadX, b.y + padTop, null).svg;
      const midY = b.y + b.h / 2;
      svg += `<path d="M${centerX + centerW},${centerY + centerH / 2} C ${centerX + centerW + 40},${centerY + centerH / 2} ${centerX + centerW + 40},${midY} ${rightX},${midY}" fill="none" stroke="${color}" stroke-opacity="0.7" marker-end="url(#udcArrow)"/>`;
    });

    // 底部人脈／資本背書
    if(hasNetwork){
      const nw = 360, nx = (VIEW_W - nw) / 2, ny = bodyH + 20;
      svg += `<rect x="${nx}" y="${ny}" width="${nw}" height="${networkH}" rx="9" fill="var(--gold-soft, var(--clay-soft))" stroke="var(--gold, var(--clay))" stroke-width="1.5"/>`;
      svg += stackLines(networkParts, VIEW_W / 2, ny + padTop, 'middle').svg;
      svg += `<path d="M${VIEW_W / 2},${ny} L${VIEW_W / 2},${centerY + centerH}" fill="none" stroke="var(--gold, var(--clay))" stroke-opacity="0.8" stroke-dasharray="5 4" marker-end="url(#udcArrow)"/>`;
    }

    svg += `</g></svg>`;
    return svg;
  }

  /* ---------------------------------------------------------
     全景圖的窄版：同樣的資料改成由上往下的單欄流程。

     為什麼要另外畫一張，而不是把寬版縮小：寬版是「左→中→右」的三欄
     流程，viewBox 有 1000 單位寬。手機上可用寬度大約 327px，直接縮等於
     0.33 倍，最小的字會變成 4px，誰都看不到；維持原尺寸則要橫向捲，捲
     到右邊就看不到左邊，流程圖最重要的「誰流向誰」反而斷掉了。

     所以窄版把方向轉成垂直：入口疊在上面、公司在中間、收入來源在下面，
     箭頭一律朝下。viewBox 只有 360 單位寬，在手機上幾乎是 1:1 呈現，字
     級跟寬版一樣但實際看起來更大，而且完全不用捲。方框變寬（可用 300
     單位）反而讓每行放得下更多字，換行次數比寬版還少。

     兩張圖都會進 DOM，用 CSS media query 決定顯示哪一張——報告是存資料
     不是存 HTML，多畫一張不佔任何儲存空間。
  --------------------------------------------------------- */
  function buildDiagramNarrowSVG(diagram){
    const inputs = Array.isArray(diagram.inputs) ? diagram.inputs.slice(0, 3) : [];
    const outputs = Array.isArray(diagram.outputs) ? diagram.outputs.slice(0, 5) : [];
    const hasNetwork = !!diagram.has_network && diagram.network && (diagram.network.title || (diagram.network.lines || []).length);

    const VIEW_W = 360;
    const margin = 14, boxW = VIEW_W - margin * 2, padX = 16, padTop = 18, padBottom = 18;
    const stackGap = 12;  // 同一組之內，方框跟方框的距離
    const flowGap = 30;   // 組跟組之間，留給箭頭的距離
    const cx = VIEW_W / 2;

    function inputParts(b){
      const parts = [
        { text: b.title, fontSize: 17, weight: 700, color: 'currentColor', maxUnits: 17, maxLines: 2, lineHeight: 23 },
      ];
      for(const line of (b.lines || [])){
        parts.push({ text: line, fontSize: 14, color: 'currentColor', opacity: 0.72, maxUnits: 21, maxLines: 2, lineHeight: 20, gapBefore: parts.length === 1 ? 5 : 0 });
      }
      if(b.status){
        parts.push({ text: b.status, fontSize: 13, weight: 700, color: 'var(--accent)', maxUnits: 22, maxLines: 1, lineHeight: 20, gapBefore: 7 });
      }
      return parts;
    }
    function outputParts(b, color){
      return [
        { text: b.title, fontSize: 16, weight: 700, color: 'currentColor', maxUnits: 18, maxLines: 2, lineHeight: 22 },
        { text: b.value, fontSize: 19, weight: 700, color, maxUnits: 15, maxLines: 1, lineHeight: 25, gapBefore: 5 },
        { text: b.desc, fontSize: 13, color: 'currentColor', opacity: 0.65, maxUnits: 22, maxLines: 2, lineHeight: 19, gapBefore: 5 },
      ];
    }
    const centerParts = [
      { text: diagram.center && diagram.center.title, fontSize: 18, weight: 700, color: 'var(--accent-ink)', maxUnits: 16, maxLines: 2, lineHeight: 25 },
      ...((diagram.center && diagram.center.lines) || []).map((line, i) => ({
        text: line, fontSize: 14, color: 'currentColor', opacity: 0.8, maxUnits: 21, maxLines: 2, lineHeight: 21, gapBefore: i === 0 ? 7 : 0,
      })),
    ];
    const centerFlag = diagram.center && diagram.center.flag;
    const networkParts = hasNetwork ? [
      { text: diagram.network.title, fontSize: 16, weight: 700, color: 'var(--gold, var(--clay))', maxUnits: 18, maxLines: 2, lineHeight: 22 },
      ...(diagram.network.lines || []).map(line => ({ text: line, fontSize: 13, color: 'var(--gold, var(--clay))', maxUnits: 22, maxLines: 2, lineHeight: 19, gapBefore: 4 })),
    ] : [];

    function boxHeight(parts, extra){
      const { endY } = stackLines(parts, 0, 0, null);
      return Math.max(64, padTop + endY + (extra || 0) + padBottom);
    }

    // 先把每一塊的高度與 y 座標算完，最後才知道 viewBox 要多高
    const laid = [];
    let y = margin;
    function place(kind, parts, opts){
      const h = boxHeight(parts, (opts && opts.extra) || 0);
      laid.push({ kind, parts, y, h, ...(opts || {}) });
      y += h;
      return h;
    }
    function arrow(dashed){
      laid.push({ kind: 'arrow', y, h: flowGap, dashed: !!dashed });
      y += flowGap;
    }

    inputs.forEach((b, i) => {
      place('box', inputParts(b), { stroke: 'currentColor', strokeOpacity: 0.35 });
      if(i < inputs.length - 1) y += stackGap;
    });
    if(inputs.length) arrow(false);
    place('box', centerParts, { center: true, extra: centerFlag ? 23 : 0, flag: centerFlag });
    if(outputs.length) arrow(false);
    outputs.forEach((b, i) => {
      place('box', outputParts(b, seriesColor(i + 1)), { stroke: seriesColor(i + 1), strokeWidth: 1.5 });
      if(i < outputs.length - 1) y += stackGap;
    });
    if(hasNetwork){
      arrow(true);
      place('box', networkParts, { network: true });
    }
    const VIEW_H = y + margin;

    let svg = `<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="商業模式全景圖（窄版）：由上而下依序是進入管道、公司本身、收入來源">`;
    svg += `<defs><marker id="udcArrowN" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`;
    svg += `<g font-family="var(--font-body)">`;

    for(const item of laid){
      if(item.kind === 'arrow'){
        const stroke = item.dashed ? 'var(--gold, var(--clay))' : 'currentColor';
        svg += `<path d="M${cx},${item.y + 4} L${cx},${item.y + flowGap - 4}" fill="none" stroke="${stroke}" stroke-opacity="0.6"${item.dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#udcArrowN)"/>`;
        continue;
      }
      if(item.center){
        svg += `<rect x="${margin}" y="${item.y}" width="${boxW}" height="${item.h}" rx="11" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/>`;
        svg += stackLines(item.parts, cx, item.y + padTop, 'middle').svg;
        if(item.flag){
          svg += `<text x="${cx}" y="${item.y + item.h - padBottom - 3}" font-size="13" fill="var(--clay)" font-weight="700" text-anchor="middle">${esc(item.flag)}</text>`;
        }
      } else if(item.network){
        svg += `<rect x="${margin}" y="${item.y}" width="${boxW}" height="${item.h}" rx="9" fill="var(--gold-soft, var(--clay-soft))" stroke="var(--gold, var(--clay))" stroke-width="1.5"/>`;
        svg += stackLines(item.parts, cx, item.y + padTop, 'middle').svg;
      } else {
        svg += `<rect x="${margin}" y="${item.y}" width="${boxW}" height="${item.h}" rx="9" fill="none" stroke="${item.stroke}"${item.strokeOpacity ? ` stroke-opacity="${item.strokeOpacity}"` : ''}${item.strokeWidth ? ` stroke-width="${item.strokeWidth}"` : ''}/>`;
        svg += stackLines(item.parts, margin + padX, item.y + padTop, null).svg;
      }
    }

    svg += `</g></svg>`;
    return svg;
  }

  function buildStackBar(bars){
    const total = bars.reduce((s, b) => s + (Number(b.pct) || 0), 0) || 1;
    const segs = bars.map(b => `<span style="width:${(Number(b.pct) || 0)}%; background:${seriesColor(b.slot)};"></span>`).join('');
    const legend = bars.map(b => `
      <div class="item"><span class="swatch" style="background:${seriesColor(b.slot)};"></span><span class="name">${esc(b.name)}</span><span class="pct">${esc(b.pct)}%</span></div>
    `).join('');
    return `
      <div class="barviz">
        <div class="stackbar">${segs}</div>
        <div class="bar-legend">${legend}</div>
      </div>
    `;
  }

  function buildFact(fact, idx, answerCount){
    /* 標上「答案 N」，讀者才知道這一段是在驗證第 02 節的哪一個。原本全篇只有
       卡片上寫著 H1、H2，驗證的段落卻從來沒提到它們，兩節之間的連結是斷的。 */
    const n = answerNumber(fact.hypo_ref);
    const ref = (n && n <= answerCount) ? `<span class="fact-ref">答案 ${n}</span>` : '';
    let html = `<h3 id="fact-${idx + 1}">${ref}${verdictTag(fact.verdict)}<span class="fact-heading">${esc(fact.heading)}</span></h3>`;
    for(const p of (fact.paragraphs || [])){
      html += `<p>${mdBold(p)}</p>`;
    }
    if(fact.has_diagram && fact.diagram){
      html += `
        <figure class="wide-figure">
          <div class="diagram-frame diagram-wide">${buildDiagramSVG(fact.diagram)}</div>
          <div class="diagram-frame diagram-narrow">${buildDiagramNarrowSVG(fact.diagram)}</div>
          <figcaption><span class="fig-tag">FIG. 1</span>商業模式全景圖</figcaption>
        </figure>
      `;
    }
    if(fact.has_stats && (fact.stats || []).length){
      html += `<div class="stat-row">` + fact.stats.map(s => `
        <div class="stat-tile"><div class="lbl">${esc(s.lbl)}</div><div class="num${s.flag ? ' flag' : ''}">${esc(s.num)}</div>${s.sub ? `<div class="sub">${esc(s.sub)}</div>` : ''}</div>
      `).join('') + `</div>`;
    }
    if(fact.has_bars && (fact.bars || []).length){
      html += buildStackBar(fact.bars);
    }
    if(fact.has_bullets && (fact.bullets || []).length){
      html += `<ul class="clean">` + fact.bullets.map(b => `<li>${mdBold(b)}</li>`).join('') + `</ul>`;
    }
    if(fact.has_forces && (fact.forces || []).length){
      html += `<ul class="forces-list">` + fact.forces.map(f => `<li><span class="fname">${esc(f.name)}</span><span class="fdesc">${esc(f.desc)}</span></li>`).join('') + `</ul>`;
    }
    return html;
  }

  /* 後端回傳的是攤平過的平行陣列（見 worker/index.js 裡 BMR_SCHEMA
     的註解：巢狀 array-of-object 會讓 Claude API 的 structured output
     編譯出過大的文法，所以改成 xxx_labels / xxx_values 這種同長度
     陣列，用索引對應）。這裡在畫面渲染之前先「zip」回原本好處理的
     巢狀物件結構，下面的 render/buildFact/buildDiagramSVG 完全不用
     知道後端存的其實是攤平格式。 */
  /* 把「可能是字串、也可能是陣列」的文字欄位收斂成一組段落。

     模型對 problem_intro / solution_limitations / solution_summary 這幾個
     自由文字欄位並不穩定：有時候回一整串字，有時候回一條一條的陣列。
     原本 limitations 是直接丟給 mdBold()，陣列會被 String() 用半形逗號
     黏成一大段——線上出現過「…公開資訊觀測站。,無法確認…」這種句號
     後面接逗號的句子，五條侷限擠成一整塊。intro 則相反：如果模型回字串，
     原本的 .map() 會直接拋錯。兩邊都在這裡處理掉。 */
  function toParagraphs(v){
    if(Array.isArray(v)) return v.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    return String(v == null ? '' : v).split(/\n+/).map(s => s.trim()).filter(Boolean);
  }

  function zip(...arrays){
    const lens = arrays.map(a => (Array.isArray(a) ? a.length : 0));
    const len = lens.length ? Math.min(...lens) : 0;
    const out = [];
    for(let i = 0; i < len; i++) out.push(arrays.map(a => a[i]));
    return out;
  }

  function normalize(raw){
    const d = raw || {};
    const snapshot = zip(d.snapshot_labels, d.snapshot_values).map(([k, v]) => ({ k, v }));
    const registry_table = zip(d.registry_labels, d.registry_values).map(([th, td]) => ({ th, td }));
    const board_members = zip(d.board_names, d.board_roles).map(([name, role]) => ({ name, role }));
    const mece = zip(d.mece_labels, d.mece_texts).map(([label, text]) => ({ label, text }));
    const hypotheses = zip(d.hypo_labels, d.hypo_texts).map(([label, text]) => ({ label, text }));

    const stats = zip(d.stat_labels, d.stat_values, d.stat_subs).map(([lbl, num, sub]) => ({
      lbl, num, sub, flag: !!lbl && lbl === d.stat_flag_label,
    }));
    const bars = zip(d.bar_names, d.bar_pcts).map(([name, pct], i) => ({ name, pct: Number(pct) || 0, slot: (i % 5) + 1 }));
    const forces = zip(d.force_names, d.force_descs).map(([name, desc]) => ({ name, desc }));
    const bullets = Array.isArray(d.bullets) ? d.bullets : [];

    const diagram = {
      inputs: zip(d.diagram_input_names, d.diagram_input_descs).map(([title, desc]) => ({
        title, lines: String(desc || '').split('\n').filter(Boolean), status: d.diagram_input_status || '',
      })),
      center: {
        title: d.diagram_center_name || '',
        lines: String(d.diagram_center_desc || '').split('\n').filter(Boolean),
        flag: d.diagram_center_flag || '',
      },
      outputs: zip(d.diagram_output_names, d.diagram_output_values, d.diagram_output_descs).map(([title, value, desc]) => ({ title, value, desc })),
      has_network: !!(d.diagram_network_name && String(d.diagram_network_name).trim()),
      network: {
        title: d.diagram_network_name || '',
        lines: String(d.diagram_network_desc || '').split('\n').filter(Boolean),
      },
    };

    // 「附掛在哪個 fact 底下」是用 hypo_ref 字串比對，但沒辦法保證
    // AI 產出的 fact_hypo_refs 裡不會意外出現重複值（例如兩個 fact
    // 都標成 "H1"）——如果每個相符的 fact 都掛一次，畫面上同一張
    // 全景圖／同一組數字就會重複出現好幾次。用「用過一次就標記掉」
    // 確保每個區塊全篇最多只附掛一次，不管 hypo_ref 是否重複命中。
    let diagramClaimed = false, statsClaimed = false, barsClaimed = false, bulletsClaimed = false, forcesClaimed = false;
    const facts = zip(d.fact_hypo_refs, d.fact_verdicts, d.fact_headings, d.fact_bodies).map(([hypo_ref, verdict, heading, body]) => {
      const paragraphs = String(body || '').split(/\n\n+/).filter(Boolean);
      const isDiagramFact = !diagramClaimed && !!d.diagram_hypo_ref && d.diagram_hypo_ref === hypo_ref;
      const isStatsFact = !statsClaimed && !!d.stats_hypo_ref && d.stats_hypo_ref === hypo_ref;
      const isBarsFact = !barsClaimed && !!d.bars_hypo_ref && d.bars_hypo_ref === hypo_ref;
      const isBulletsFact = !bulletsClaimed && !!d.bullets_hypo_ref && d.bullets_hypo_ref === hypo_ref;
      const isForcesFact = !forcesClaimed && !!d.forces_hypo_ref && d.forces_hypo_ref === hypo_ref;
      if(isDiagramFact) diagramClaimed = true;
      if(isStatsFact) statsClaimed = true;
      if(isBarsFact) barsClaimed = true;
      if(isBulletsFact) bulletsClaimed = true;
      if(isForcesFact) forcesClaimed = true;
      return {
        hypo_ref, verdict, heading, paragraphs,
        has_diagram: isDiagramFact, diagram,
        has_stats: isStatsFact, stats,
        has_bars: isBarsFact, bars,
        has_bullets: isBulletsFact, bullets: isBulletsFact ? bullets : [],
        has_forces: isForcesFact, forces,
      };
    });

    return {
      title: d.title, subtitle: d.subtitle, company_name: d.company_name,
      snapshot, lede: d.lede,
      problem: { intro: toParagraphs(d.problem_intro), registry_table, board_members, scope_tags: d.scope_tags || [], mece },
      hypotheses, facts,
      solution: {
        verdict_summary: toParagraphs(d.solution_summary).join('　'),
        actions: zip(d.action_titles, d.action_descs).map(([h, p]) => ({ h, p })),
        limitations: toParagraphs(d.solution_limitations),
      },
      sources: zip(d.source_labels, d.source_urls).map(([label, url]) => ({ label, url })),
    };
  }

  /* ---------------------------------------------------------
     目錄。

     寬畫面：固定在正文欄右側，跟著捲動高亮目前讀到的段落。
     窄畫面：收成右下角一顆小小的「目錄」按鈕，點開才出現清單；往下讀
     的時候按鈕自己縮下去，往回捲才出現——手機螢幕已經很小，常駐的東西
     每一像素都是從文章那裡借來的。

     點擊不能直接靠 <a href="#sec-1">：報告是塞進 iframe 的 srcdoc，而
     srcdoc 文件的 #錨點是以「父頁」的網址為基準解析的——瀏覽器會把整個
     父頁（主站）載進這個 iframe 裡，而不是捲到段落。所以一律攔下點擊，
     自己用 scrollIntoView 捲過去。href 仍然保留，給讀螢幕的輔助工具看。
  --------------------------------------------------------- */
  function buildToc(facts, answerCount){
    const factItems = facts.map((f, i) => {
      const n = answerNumber(f.hypo_ref);
      const label = ((n && n <= answerCount) ? `答案 ${n} · ` : '') + (f.heading || '');
      return `<li><a href="#fact-${i + 1}" data-target="fact-${i + 1}" title="${esc(label)}">${esc(label)}</a></li>`;
    }).join('');

    const nav = `
<nav class="toc" id="toc" aria-label="報告目錄">
  <div class="toc-title">目錄</div>
  <ol class="toc-list">
    <li><a href="#summary" data-target="summary">摘要</a></li>
    <li><a href="#sec-1" data-target="sec-1"><span class="toc-num">01</span>先看懂這門生意</a></li>
    <li><a href="#sec-2" data-target="sec-2"><span class="toc-num">02</span>幾個可能的答案</a></li>
    <li><a href="#sec-3" data-target="sec-3"><span class="toc-num">03</span>事實查證</a>${factItems ? `<ol class="toc-sub">${factItems}</ol>` : ''}</li>
    <li><a href="#sec-4" data-target="sec-4"><span class="toc-num">04</span>結論與建議</a></li>
  </ol>
</nav>
<button class="toc-fab" id="tocFab" type="button" aria-controls="toc" aria-expanded="false">
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
  目錄
</button>`;

    // 這段是寫死的程式碼，不含任何報告內容，所以可以直接內嵌；
    // 刻意不用反引號與 ${}，免得跟外層的樣板字串互相干擾。
    const script = `
<script>
(function(){
  var nav = document.getElementById('toc');
  var fab = document.getElementById('tocFab');
  if(!nav || !fab) return;
  var links = Array.prototype.slice.call(nav.querySelectorAll('a[data-target]'));
  var targets = links.map(function(a){ return document.getElementById(a.getAttribute('data-target')); });
  var figs = Array.prototype.slice.call(document.querySelectorAll('.wide-figure'));
  var wide = window.matchMedia('(min-width: 1120px)');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  function setOpen(open){
    nav.classList.toggle('open', open);
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  fab.addEventListener('click', function(e){ e.stopPropagation(); setOpen(!nav.classList.contains('open')); });
  document.addEventListener('click', function(e){
    if(nav.classList.contains('open') && !nav.contains(e.target) && !fab.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') setOpen(false); });

  links.forEach(function(a, i){
    a.addEventListener('click', function(e){
      e.preventDefault();
      var t = targets[i];
      if(t) t.scrollIntoView({ behavior: reduce.matches ? 'auto' : 'smooth', block: 'start' });
      setOpen(false);
    });
  });

  var lastY = window.pageYOffset, ticking = false;
  function update(){
    ticking = false;
    var y = window.pageYOffset;
    var vh = window.innerHeight;

    /* 目前讀到哪裡：最後一個已經捲到畫面上緣的標題。門檻是 48px——點目錄
       後標題會停在離頂端 24px（scroll-margin-top）的地方，門檻要剛好蓋過它；
       設太大的話，點「摘要」時下一個標題也已經在門檻內，亮起來的會是 01。 */
    var active = 0;
    for(var i = 0; i < targets.length; i++){
      if(targets[i] && targets[i].getBoundingClientRect().top <= 48) active = i;
    }
    // 捲到底時最後幾段可能永遠碰不到上緣，改成畫面裡最後一個出現的標題
    if(vh + y >= document.documentElement.scrollHeight - 4){
      for(var j = targets.length - 1; j >= 0; j--){
        if(targets[j] && targets[j].getBoundingClientRect().top < vh){ active = j; break; }
      }
    }
    links.forEach(function(a, k){ a.classList.toggle('active', k === active); });

    if(wide.matches){
      // 全景圖會往兩側撐開，捲過目錄底下時讓目錄先讓開，不要疊在圖上
      var r = nav.getBoundingClientRect();
      var covered = figs.some(function(f){
        var b = f.getBoundingClientRect();
        return b.bottom > r.top && b.top < r.bottom && b.right > r.left && b.left < r.right;
      });
      nav.classList.toggle('toc-covered', covered);
      fab.classList.remove('toc-away');
    } else {
      nav.classList.remove('toc-covered');
      if(!nav.classList.contains('open')){
        if(y > lastY + 6 && y > 160) fab.classList.add('toc-away');
        else if(y < lastY - 6 || y <= 160) fab.classList.remove('toc-away');
      }
    }
    if(Math.abs(y - lastY) > 6) lastY = y;
  }
  function onScroll(){ if(!ticking){ ticking = true; requestAnimationFrame(update); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function(){ setOpen(false); onScroll(); });
  update();
})();
<\/script>`;

    return nav + script;
  }

  /* 第二個參數是報告的「資料時點」。投資人看報告最怕的就是不知道內容有多舊：
     同一份報告可能是這個月生成的，也可能是別人上個月生成、被分享出來的。
     報告只呈現生成當下查得到的公開資訊，所以日期要跟標題放在一起，不是藏在角落。 */
  /* 資料時點那一行。拿不到日期時就不顯示——寧可少一行，也不要寫一個猜的日期。 */
  function reportDateLine(meta){
    const raw = meta && meta.created_at;
    const d = raw ? new Date(raw) : null;
    if(!d || isNaN(d.getTime())) return '';
    // 台灣時間，跟快取的月份界線一致
    const taipei = new Date(d.getTime() + 8 * 3600 * 1000);
    const [y, m, day] = taipei.toISOString().slice(0, 10).split('-');
    return `<p class="report-date">本報告依 <b>${y} 年 ${Number(m)} 月 ${Number(day)} 日</b>` +
      ' 查得到的公開資訊生成。公司狀況可能已經改變，引用前請以最新的公開資訊與財報為準。</p>';
  }

  function render(rawData, meta){
    const d = normalize(rawData);
    const snapshot = Array.isArray(d.snapshot) ? d.snapshot.slice(0, 4) : [];
    const problem = d.problem || {};
    const hypotheses = Array.isArray(d.hypotheses) ? d.hypotheses : [];
    const facts = Array.isArray(d.facts) ? d.facts : [];
    const solution = d.solution || {};
    const sources = Array.isArray(d.sources) ? d.sources : [];

    const boardPills = (problem.board_members || []).map(m =>
      `<span class="board-pill${m.role === 'chair' ? ' chair' : ''}">${esc(m.name)}${m.role === 'independent' ? ' 獨董' : ''}</span>`
    ).join('');

    const scopeTags = (problem.scope_tags || []).map(t => `<span>${esc(t)}</span>`).join('');

    const registryRows = (problem.registry_table || []).map(r => `<tr><th>${esc(r.th)}</th><td>${mdBold(r.td)}</td></tr>`).join('');

    return `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title || (d.company_name ? d.company_name + '商業模式報告' : '商業模式報告'))}</title>
<style>
  :root{
    color-scheme: light;
    --paper:#F2F5F1; --panel:#FBFCFA; --panel-2:#EAEFE9;
    --ink:#16241E; --ink-soft:#45564D; --muted:#7C8F85;
    --line:#D6DED6; --line-strong:#B7C4B9;
    --accent:#1F6E5C; --accent-ink:#0F4438; --accent-soft:#DCEBE5;
    --clay:#B34E2B; --clay-soft:#F3E1D6;
    --gold:#9C6D14; --gold-soft:#F1E6CE;
    --good:#0ca30c; --bad:#C1502E;
    --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a; --series-4:#eda100; --series-5:#e87ba4;
    /* 標題原本用 Georgia 襯線體，但 Georgia 只有拉丁字母——中文會退回系統
       的黑體，結果同一句話裡「ASSA ABLOY」是襯線、中文是黑體，數字還是
       Georgia 的舊式數字（1954 的 9 跟 5 會往下掉）。對讀中文的人來說，
       襯線的「報告感」根本不存在，只剩混雜。改成跟內文同一套字，靠字重和
       字級分出層級。 */
    --font-display: var(--font-body);
    --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", Roboto, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Cascadia Code", Consolas, "Courier New", monospace;
    --measure: 640px; /* 正文一行的寬度上限，約 40 個中文字。見下面 p 的說明 */
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      color-scheme: dark;
      --paper:#0E1512; --panel:#151F1A; --panel-2:#1B2721;
      --ink:#E7EDE8; --ink-soft:#AFC2B6; --muted:#728578;
      --line:#29362F; --line-strong:#39493F;
      --accent:#4FC9AC; --accent-ink:#A9EBD9; --accent-soft:#1C3830;
      --clay:#E68A5E; --clay-soft:#3A2A20;
      --gold:#E0A548; --gold-soft:#332711;
      --good:#3fc23f; --bad:#E68A5E;
      --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500; --series-5:#d55181;
    }
  }
  :root[data-theme="dark"]{
    color-scheme: dark;
    --paper:#0E1512; --panel:#151F1A; --panel-2:#1B2721;
    --ink:#E7EDE8; --ink-soft:#AFC2B6; --muted:#728578;
    --line:#29362F; --line-strong:#39493F;
    --accent:#4FC9AC; --accent-ink:#A9EBD9; --accent-soft:#1C3830;
    --clay:#E68A5E; --clay-soft:#3A2A20;
    --gold:#E0A548; --gold-soft:#332711;
    --good:#3fc23f; --bad:#E68A5E;
    --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500; --series-5:#d55181;
  }
  *{ box-sizing:border-box; }
  /* 中文沒有詞距，行高要比英文寬才不會糊成一片，1.8 是長文比較舒服的值 */
  body{ margin:0; background:var(--paper); color:var(--ink); font-family:var(--font-body); line-height:1.8; font-size:16px; -webkit-font-smoothing:antialiased; }
  /* 欄寬就是正文寬度，沒有第二種寬度。

     原本 .page 是 840px（內容 792px），正文另外限制在 640px——結果同一頁
     上有兩種右邊界：文字排到 640 就換行，但卡片、表格、假設卡、摘要條都
     一路撐到 792。讀者在文字段落旁邊會看到一條 150px 的空白，換到下一個
     卡片區塊又忽然滿版，整頁看起來重心偏左。

     所以不是把文字加寬（40 字一行是刻意的），而是把整欄收到跟文字一樣
     寬。全景圖本來就會自己往兩側撐開（見 .wide-figure），是唯一需要更寬
     的東西，收窄欄寬不影響它。

     一旦欄寬 = --measure，個別區塊就不需要再各自寫 max-width 了——這正是
     上一版對不齊的來源（有的寫了、有的沒寫、有的寫了但沒把內距算進去）。 */
  .page{ max-width:calc(var(--measure) + 48px); margin:0 auto; padding:40px 24px 96px; }
  /* 全景圖要跳出 840px 的文字欄寬。

     這是「圖裡的字太小」真正的原因：圖是照 viewBox 1000 的座標畫的，
     但 .page 只有 840px、扣掉內距與外框之後圖框實際只有約 762px，等於
     整張圖被縮到 76% 才畫出來——font-size 11 到螢幕上只剩 8.4px。原本
     有一段「有全景圖的 section 放寬到 1080px」的設定，但那個 section
     長在 .page 裡面，父層 840 一擋就完全沒有作用。

     這裡改成讓圖自己往兩側撐開：寬度取「文字欄寬」與「視窗寬減邊界」
     之間比較大的那個，再用負的左外距把它拉回置中。文字欄寬維持 840
     不變（40 字一行是刻意的），只有圖變寬。 */
  .wide-figure{
    margin:20px 0 8px;
    --fig-w: max(100%, min(1160px, calc(100vw - 48px)));
    width: var(--fig-w);
    margin-left: calc((100% - var(--fig-w)) / 2);
  }
  .wide-figure .diagram-frame, .diagram-frame{
    border:1px solid var(--line); border-radius:12px; background:var(--panel);
    padding:18px 14px 8px; overflow-x:auto;
  }
  /* 寬版在視窗窄到會擠成一團時就橫向捲，不要繼續縮小字；不過在那之前
     media query 就已經換成窄版了，所以實務上只有介於兩者之間的視窗會用到。 */
  .diagram-wide svg{ display:block; width:100%; height:auto; min-width:860px; }
  /* 窄版 viewBox 只有 360，直接跟著容器寬度縮放，不設 min-width、不橫捲。 */
  .diagram-narrow{ display:none; }
  .diagram-narrow svg{ display:block; width:100%; height:auto; }
  @media (max-width:760px){
    /* 窄版本來就是照欄寬設計的，不需要往外撐；而且 100vw 含捲軸、100% 不含，
       在有捲軸的手機上硬撐會比其他區塊多凸出 8px——正好是最刺眼的那種歪。 */
    .wide-figure{ width:auto; margin-left:0; }
    .diagram-wide{ display:none; }
    .diagram-narrow{ display:block; }
    /* 手機上每一個像素都是字級：圖框的左右內距從 14 收到 8，換來的 12px
       直接變成縮放比，圖裡最小的字大概多 0.4px。 */
    .diagram-narrow{ padding:12px 8px 6px; }
  }
  figcaption{ font-size:14px; color:var(--muted); margin-top:10px; }
  .fig-tag{ font-family:var(--font-mono); color:var(--gold); font-weight:700; margin-right:8px; }
  /* 眉標原本前面有一條 22px 的裝飾線、字距 0.14em、全大寫、等寬字——那是
     英文雜誌的做法。中文沒有大小寫，拉開字距會變成「個 案 研 究」一個一個
     散開，前面那條線在中文裡看起來像破折號。 */
  .eyebrow{ font-size:13px; font-weight:600; letter-spacing:0.02em; color:var(--accent); }
  h1{ font-family:var(--font-display); font-weight:600; font-size:clamp(26px,4.4vw,38px); line-height:1.28; margin:14px 0 10px; text-wrap:balance; letter-spacing:-0.01em; }
  .subtitle{ font-size:16.5px; color:var(--ink-soft); margin:0 0 14px; }
  .report-date{ font-size:13px; color:var(--ink-soft); margin:0 0 28px;
    padding:8px 12px; border-left:3px solid var(--line-strong); background:var(--panel-2); }
  .report-date b{ color:var(--ink); }
  .snapshot-strip{ display:grid; grid-template-columns:repeat(4,1fr); border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--panel); margin-bottom:26px; }
  /* 一定要用 >（直接子層）。原本寫的是 .snapshot-strip div，這會連格子
     裡面的「標籤」「數值」兩個 div 一起選到：它們各自又多了一層 13px 內距
     （格子上方那截多出來的空白），而且「數值」不是第一個子元素，還會多出
     一條 border-left——就是每個數值左邊那條莫名其妙的直線。 */
  .snapshot-strip > div{ padding:14px 15px; border-left:1px solid var(--line); }
  .snapshot-strip > div:first-child{ border-left:none; }
  .snapshot-strip .k{ font-size:12px; color:var(--muted); margin-bottom:4px; }
  /* 數值原本是等寬字。等寬字型裡沒有中文字，瀏覽器會自己挑一套中文字補上，
     跟內文不一定是同一套；而這裡的值經常是「2022年10月14日」這種中英混排。
     用內文字型加 tabular-nums，數字一樣等寬對齊，中文也跟全篇一致。 */
  .snapshot-strip .v{ font-variant-numeric:tabular-nums; font-size:14px; font-weight:600; line-height:1.5; word-break:break-word; }
  .lede{ font-size:19px; line-height:1.65; color:var(--ink); border-left:3px solid var(--accent); padding:4px 0 4px 22px; margin:0 0 34px; }
  .lede b{ color:var(--accent-ink); font-weight:600; }
  /* 各層級的間距整體收緊約四分之一（section 52→40、lede 44→34、
     摘要條 36→26）。原本的留白是照「一頁一個重點」的簡報節奏抓的，
     但這是一份要一路往下讀完的報告，段落之間空太多會讓人一直覺得
     「還有很多沒讀完」。收緊之後層級關係還在，只是不再需要一直捲。 */
  section{ margin-bottom:40px; }
  h2{ font-family:var(--font-display); font-size:22px; font-weight:600; margin:0 0 5px; display:flex; align-items:baseline; gap:10px; }
  h2 .num{ font-family:var(--font-mono); font-size:14px; color:var(--accent); font-weight:600; }
  /* 這行原本是英文的方法論標籤（Problem Definition / Hypothesis-driven…）。
     那是裝飾，不但佔一行，還正好是報告裡最該避免的顧問腔調——內文都
     要求講白話了，標題卻在展示框架。改成一句中文，說明這一節在做什麼，
     同樣一行高度換到實際有用的資訊。 */
  .section-note{ color:var(--muted); font-size:13.5px; margin:0 0 15px; }
  /* baseline 而不是 center：標題換成兩行時，前面的「答案 1」「部分成立」要對齊
     第一行，不是飄在兩行中間。 */
  h3{ font-family:var(--font-body); font-size:15.5px; font-weight:700; line-height:1.55; margin:24px 0 8px; display:flex; align-items:baseline; gap:8px; }
  /* 段距原本 14px，比一個行高（約 29px）的一半還小，段落之間會黏在
     一起——內文本來就會用 

 切成好幾段，段距不夠等於白切。

     這裡刻意不設 max-width：欄寬本身就是 --measure（見上面 .page），
     所有區塊都自然一樣寬。個別區塊各自寫 max-width 正是之前對不齊的
     來源——有的寫了、有的沒寫、有的寫了卻沒把 padding 算進去。 */
  p{ margin:0 0 1.05em; }
  /* 資料侷限原本是一整段。它本來就是「查不到 A、查不到 B、查不到 C」的
     並列清單，寫成一段等於逼讀者自己在心裡切開；改成條列，一眼就知道
     有幾件事沒查到。 */
  .limits{ margin-top:20px; border-top:1px solid var(--line); padding-top:16px; }
  .limits h4{ margin:0 0 8px; font-size:13px; font-weight:700; color:var(--muted); }
  .limits ul{ margin:0; padding-left:20px; }
  .limits li{ font-size:14px; color:var(--ink-soft); margin-bottom:7px; }
  .limits li:last-child{ margin-bottom:0; }
  a{ color:var(--accent-ink); text-decoration-color:var(--line-strong); }
  table{ width:100%; border-collapse:collapse; font-size:14px; margin:14px 0 4px; }
  th, td{ text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th{ font-size:12.5px; color:var(--muted); font-weight:600; width:26%; }
  .board-list{ display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .board-pill{ font-size:12.5px; padding:3px 10px; border-radius:100px; border:1px solid var(--line-strong); color:var(--ink-soft); }
  .board-pill.chair{ color:var(--accent-ink); border-color:var(--accent); background:var(--accent-soft); font-weight:600; }
  .scope-tags{ display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .scope-tags span{ font-size:12px; background:var(--panel-2); border-radius:4px; padding:3px 8px; color:var(--ink-soft); }
  .mece-row{ display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:16px 0 6px; }
  .mece-card{ border:1px solid var(--line); border-radius:10px; padding:14px 16px; background:var(--panel); }
  /* 卡片上方的「問題 1」「答案 1」。01 用灰、02 用主色，兩組卡片外觀原本
     幾乎一樣，只差左邊一條色線，靠這個再分開一次。 */
  .card-kicker{ font-size:12px; font-weight:700; color:var(--muted); margin-bottom:6px; }
  .hypo-card .card-kicker{ color:var(--accent-ink); }
  .card-title{ font-size:14px; font-weight:700; color:var(--ink); margin:0 0 4px; line-height:1.5; }
  .mece-card p{ font-size:13.6px; margin:0; }
  .hypo-grid{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin:16px 0 8px; }
  .hypo-card{ border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:8px; padding:14px 16px; background:var(--panel); }
  .hypo-card p{ font-size:13.5px; margin:0; color:var(--ink-soft); }
  .tag{ font-size:12px; padding:2px 8px; border-radius:5px; font-weight:700; flex-shrink:0; }
  /* 第 03 節標題前的「答案 N」，告訴讀者這一段在驗證哪一個答案 */
  .fact-ref{ font-size:12px; font-weight:700; color:var(--muted); flex-shrink:0; }
  .fact-heading{ min-width:0; }
  .tag.yes{ background:var(--accent-soft); color:var(--accent-ink); }
  .tag.no{ background:var(--clay-soft); color:var(--clay); }
  .tag.mid{ background:var(--gold-soft); color:var(--gold); }
  .stat-row{ display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin:16px 0 20px; }
  .stat-tile{ border:1px solid var(--line); border-radius:8px; padding:13px 14px 11px; background:var(--panel); }
  .stat-tile .lbl{ font-size:11.5px; color:var(--muted); margin-bottom:6px; }
  .stat-tile .num{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:20px; font-weight:700; }
  .stat-tile .num.flag{ color:var(--gold); }
  .stat-tile .sub{ font-size:11.5px; color:var(--muted); margin-top:4px; }
  .barviz{ margin:18px 0 6px; }
  .stackbar{ display:flex; height:42px; border-radius:6px; overflow:hidden; background:var(--line); gap:2px; }
  .stackbar span{ display:block; height:100%; }
  .bar-legend{ display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-top:12px; }
  .bar-legend .item{ font-size:12.5px; }
  .bar-legend .swatch{ width:10px; height:10px; border-radius:2px; display:inline-block; margin-right:6px; position:relative; top:-1px; }
  .bar-legend .pct{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-weight:700; display:block; font-size:15px; margin-top:2px; }
  .bar-legend .name{ color:var(--ink-soft); }
  ul.clean{ margin:0 0 14px; padding-left:20px; }
  ul.clean li{ margin-bottom:8px; }
  ul.clean li b{ color:var(--accent-ink); }
  .forces-list{ margin:14px 0 6px; padding-left:0; list-style:none; }
  .forces-list li{ display:flex; gap:14px; padding:9px 0; border-bottom:1px dashed var(--line); }
  .forces-list li:last-child{ border-bottom:none; }
  .forces-list .fname{ font-size:13px; color:var(--accent-ink); font-weight:700; width:140px; flex-shrink:0; }
  .forces-list .fdesc{ font-size:13.4px; color:var(--ink-soft); }
  .callout{ background:var(--accent-soft); border:1px solid var(--line); border-radius:10px; padding:16px 18px; font-size:14.5px; margin:16px 0; }
  .callout b{ color:var(--accent-ink); }
  .two-col{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .action-card{ border:1px solid var(--line); border-radius:10px; padding:14px 16px; background:var(--panel); }
  .action-card h4{ margin:0 0 6px; font-size:14px; color:var(--accent-ink); font-family:var(--font-body); }
  .action-card p{ font-size:13.4px; margin:0; color:var(--ink-soft); }
  footer{ border-top:1px solid var(--line); padding-top:20px; margin-top:52px; font-size:12.4px; color:var(--muted); }
  footer .src-list{ margin:10px 0 0; padding-left:18px; }
  footer .src-list li{ margin-bottom:5px; }
  footer a{ color:var(--muted); }
  .share-bar{ display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-bottom:10px; }
  .share-bar button{
    font-family:var(--font-mono); font-size:12px; padding:6px 12px; border-radius:100px;
    border:1px solid var(--line-strong); background:var(--panel); color:var(--ink-soft); cursor:pointer;
  }
  .share-bar button:hover{ border-color:var(--accent); color:var(--accent-ink); }
  /* ---------- 目錄 ---------- */
  /* 捲到錨點時留一點上緣空間，標題不要貼著視窗頂 */
  section, h3[id], .lede{ scroll-margin-top:24px; }
  .toc-list, .toc-sub{ list-style:none; margin:0; padding:0; }
  .toc-title{ font-size:12px; font-weight:700; color:var(--muted); margin:0 0 8px; }
  .toc a{ display:block; text-decoration:none; color:var(--ink-soft); border-left:2px solid transparent; }
  .toc a:hover{ color:var(--ink); }
  .toc a.active{ color:var(--accent-ink); border-left-color:var(--accent); font-weight:600; }
  .toc-num{ font-family:var(--font-mono); font-size:11.5px; color:var(--muted); margin-right:6px; }
  .toc a.active .toc-num{ color:var(--accent); }
  /* 第 03 節底下的查證段落標題可能很長，最多兩行，完整內容放在 title 裡 */
  .toc-sub a{
    display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden;
  }
  .toc-fab{ display:none; }

  /* 寬畫面：貼在正文欄右邊。位置用正文欄的中線去算，不是貼著視窗右緣——
     貼視窗右緣的話，大螢幕上目錄會離文字很遠，看起來跟文章沒有關係。
     1120px 是「640 正文 + 44 間距 + 176 目錄」兩側各留得下的最小寬度。 */
  @media (min-width:1120px){
    .toc{
      position:fixed; top:40px;
      left:calc(50% + var(--measure) / 2 + 44px);
      width:176px; max-height:calc(100vh - 80px); overflow-y:auto;
      font-size:13px; line-height:1.5;
      transition:opacity .2s ease;
    }
    .toc a{ padding:5px 0 5px 12px; }
    .toc-sub{ margin:2px 0 4px; }
    .toc-sub a{ font-size:12px; padding:3px 0 3px 22px; }
    .toc.toc-covered{ opacity:0; pointer-events:none; }
  }

  /* 窄畫面：右下角一顆小按鈕，點開才有清單。
     按鈕 13px、高 36px，比內文小一號，刻意不做成搶眼的樣子；清單項目
     14px、每列至少 36px 高，手指點得到但不會大到蓋掉半個螢幕。 */
  @media (max-width:1119.98px){
    .toc{
      position:fixed; z-index:20;
      right:16px; bottom:calc(62px + env(safe-area-inset-bottom));
      width:min(300px, calc(100vw - 32px)); max-height:min(60vh, 440px); overflow-y:auto;
      background:var(--panel); border:1px solid var(--line-strong); border-radius:12px;
      box-shadow:0 12px 32px rgba(0,0,0,.16);
      padding:12px 8px; font-size:14px; line-height:1.5;
      opacity:0; transform:translateY(8px); visibility:hidden; pointer-events:none;
      transition:opacity .16s ease, transform .16s ease, visibility .16s;
    }
    .toc.open{ opacity:1; transform:none; visibility:visible; pointer-events:auto; }
    .toc-title{ padding:0 10px; }
    .toc a{ padding:8px 10px; border-left:none; border-radius:8px; }
    .toc a.active{ background:var(--accent-soft); }
    .toc-sub a{ font-size:13px; padding:6px 10px 6px 26px; }
    .toc-fab{
      display:inline-flex; align-items:center; gap:6px;
      position:fixed; z-index:21; right:16px; bottom:calc(16px + env(safe-area-inset-bottom));
      height:36px; padding:0 14px; border-radius:18px;
      border:1px solid var(--line-strong); background:var(--panel); color:var(--ink-soft);
      font:inherit; font-size:13px; font-weight:600; cursor:pointer;
      box-shadow:0 4px 14px rgba(0,0,0,.12);
      transition:transform .2s ease, opacity .2s ease;
    }
    .toc-fab[aria-expanded="true"]{ color:var(--accent-ink); border-color:var(--accent); }
    /* 往下讀的時候縮下去，往回捲才出現 */
    .toc-fab.toc-away{ transform:translateY(70px); opacity:0; pointer-events:none; }
  }
  @media print{ .toc, .toc-fab{ display:none !important; } }

  @media (max-width:640px){
    /* 手機一次看到的高度只有桌機的一半左右，同樣的留白比例在小螢幕
       上會變成「捲了半天還沒到內容」，所以再收一次。 */
    section{ margin-bottom:30px; }
    .lede{ font-size:18px; margin:0 0 26px; padding-left:16px; }
    .snapshot-strip{ grid-template-columns:repeat(2,1fr); margin-bottom:22px; }
    .snapshot-strip > div:nth-child(3){ border-left:none; }
    /* 兩欄時會排成兩列，第二列上面原本沒有線，看起來像飄在框裡 */
    .snapshot-strip > div:nth-child(n+3){ border-top:1px solid var(--line); }
    .mece-row{ grid-template-columns:1fr; }
    .hypo-grid{ grid-template-columns:1fr; }
    .stat-row{ grid-template-columns:1fr; }
    .two-col{ grid-template-columns:1fr; }
  }
</style>
</head><body>
<div class="page">

  <div class="eyebrow">個案研究 · 商業模式判讀</div>
  <h1>${esc(d.title)}</h1>
  <p class="subtitle">${mdBold(d.subtitle)}</p>
  ${reportDateLine(meta)}

  <div class="snapshot-strip">
    ${snapshot.map(s => `<div><div class="k">${esc(s.k)}</div><div class="v">${esc(s.v)}</div></div>`).join('')}
  </div>

  <p class="lede" id="summary">${mdBold(d.lede)}</p>

  <section id="sec-1">
    <h2><span class="num">01</span> 先看懂這門生意</h2>
    <p class="section-note">這間公司的基本資料，以及這份報告要回答的問題。</p>
    ${(problem.intro || []).map(p => `<p>${mdBold(p)}</p>`).join('')}
    ${registryRows ? `<table>${registryRows}</table>` : ''}
    ${boardPills ? `<div class="board-list">${boardPills}</div>` : ''}
    ${scopeTags ? `<div class="scope-tags">${scopeTags}</div>` : ''}
    ${(problem.mece || []).length ? `
      <div class="mece-row">
        ${problem.mece.map((m, i) => {
          const title = cardTitle(m.label);
          return `<div class="mece-card"><div class="card-kicker">問題 ${i + 1}</div>`
            + (title ? `<div class="card-title">${esc(title)}</div>` : '')
            + `<p>${mdBold(m.text)}</p></div>`;
        }).join('')}
      </div>
    ` : ''}
  </section>

  <section id="sec-2">
    <h2><span class="num">02</span> 幾個可能的答案</h2>
    <p class="section-note">查證之前，先把說得通的解釋列出來。</p>
    <div class="hypo-grid">
      ${hypotheses.map((h, i) => {
        const title = cardTitle(h.label);
        return `<div class="hypo-card"><div class="card-kicker">答案 ${i + 1}</div>`
          + (title ? `<div class="card-title">${esc(title)}</div>` : '')
          + `<p>${mdBold(h.text)}</p></div>`;
      }).join('')}
    </div>
  </section>

  <section id="sec-3">
    <h2><span class="num">03</span> 事實查證</h2>
    <p class="section-note">一條一條對照查到的資料，看哪個答案站得住。</p>
    ${facts.map((f, i) => buildFact(f, i, hypotheses.length)).join('')}
  </section>

  <section id="sec-4">
    <h2><span class="num">04</span> 結論與建議</h2>
    <p class="section-note">根據上面的查證，給出判斷和可以做的事。</p>
    ${solution.verdict_summary ? `<div class="callout"><b>驗證小結：</b>${mdBold(solution.verdict_summary)}</div>` : ''}
    ${(solution.actions || []).length ? `
      <div class="two-col">
        ${solution.actions.map(a => `<div class="action-card"><h4>${esc(a.h)}</h4><p>${mdBold(a.p)}</p></div>`).join('')}
      </div>
    ` : ''}
    ${(solution.limitations || []).length ? `
      <div class="limits">
        <h4>資料侷限</h4>
        <ul>${solution.limitations.map(t => `<li>${mdBold(t)}</li>`).join('')}</ul>
      </div>
    ` : ''}
  </section>

  <footer>
    <div>資料時效：本報告由 AI 根據公開網路資訊自動研究、生成，非官方揭露，非會計師或律師簽證，投資與商業決策請自行查證第一手資料。</div>
    ${sources.length ? `<ol class="src-list">${sources.map(s => {
      const href = safeHttpUrl(s.url);
      return href
        ? `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a></li>`
        : `<li>${esc(s.label)}</li>`;
    }).join('')}</ol>` : ''}
  </footer>

</div>

${buildToc(facts, hypotheses.length)}
</body></html>`;
  }

  global.UDCReport = { render, escapeHtml: esc };

})(typeof window !== 'undefined' ? window : globalThis);
