/*
 * fractal original（sprint 20260823-165314 / FR-PPV-02..04 — MOD-PptxRenderer）。
 * パーサ（移植層）の出力 JSON（座標 pt・path/pathViewBox・構造化 runs・placeholder/テーマ解決済み）を
 * 絶対配置 div + <svg><path> で描画する。**windowed**（IntersectionObserver で可視 ± margin のみ実 DOM）。
 * **shape 単位 try/catch**（1 図形の異常でスライドを落とさない — ppv-error-box）。
 * テキストは runs → createElement + textContent + el.style.cssText（INV-2: HTML 文字列注入 API 不使用）。
 * 縦書き（FR-PPV-03）: eaVert/vert = writing-mode: vertical-rl / vert270 = vertical-rl + 180° 回転。
 */

export const PT_PX = 4 / 3;

function ensureStyle(doc) {
    if (doc.getElementById('fv-pptx-style')) { return; }
    const style = doc.createElement('style');
    style.id = 'fv-pptx-style';
    style.textContent = [
        '.ppv-root { padding: 16px 0; }',
        '.ppv-slide { position: relative; margin: 0 auto 16px; background: #fff; overflow: hidden;',
        '  box-shadow: 0 1px 4px rgba(0,0,0,0.25); }',
        '.ppv-el { position: absolute; }',
        '.ppv-el svg { position: absolute; inset: 0; overflow: visible; }',
        '.ppv-text { position: absolute; inset: 0; display: flex; flex-direction: column;',
        '  overflow: hidden; white-space: pre-wrap; word-break: break-word; }',
        '.ppv-text p { margin: 0; min-height: 1em; }',
        '.ppv-text.ppv-vert { writing-mode: vertical-rl; }',
        '.ppv-text.ppv-vert270 { writing-mode: vertical-rl; transform: rotate(180deg); }',
        '.ppv-valign-mid { justify-content: center; } .ppv-valign-down { justify-content: flex-end; }',
        '.ppv-link { text-decoration: underline; cursor: pointer; }',
        '.ppv-placeholder { display: flex; align-items: center; justify-content: center; width: 100%;',
        '  height: 100%; border: 1px dashed rgba(128,128,128,0.6); color: rgba(90,90,90,0.9);',
        '  font-size: 12px; background: rgba(200,200,200,0.15); box-sizing: border-box; }',
        '.ppv-error-box { border: 1px dashed #c33; width: 100%; height: 100%; box-sizing: border-box; }',
        '.ppv-table { border-collapse: collapse; width: 100%; height: 100%; }',
        '.ppv-table td { border: 1px solid rgba(128,128,128,0.5); padding: 2px 4px; vertical-align: top;',
        '  font-size: 12px; }',
        '.fv-find-hit { background: rgba(255, 213, 79, 0.6); }',
        '.fv-find-current { background: rgba(255, 150, 50, 0.95); }',
    ].join('\n');
    doc.head.appendChild(style);
}

const normFill = (fill) => {
    if (!fill) { return null; }
    if (typeof fill === 'string') { return fill.startsWith('#') || fill.startsWith('rgb') ? fill : '#' + fill; }
    if (fill.type === 'color' && typeof fill.value === 'string') { return normFill(fill.value); }
    if (fill.type === 'image' && fill.value && fill.value.picBase64) { return { image: fill.value.picBase64 }; }
    if (fill.type === 'gradient' && fill.value && Array.isArray(fill.value.colors) && fill.value.colors.length) {
        return normFill(fill.value.colors[0].color); // グラデは先頭色で近似（プレビュー割り切り）
    }
    return null;
};

function renderRuns(doc, host, content) {
    if (!content || !content.paragraphs) { return; }
    for (const para of content.paragraphs) {
        const p = doc.createElement('p');
        try { p.style.cssText = para.css || ''; } catch (e) { /* 不正 css は無視 */ }
        if (para.listType) { p.style.paddingLeft = `${(para.listLevel + 1) * 18}px`; }
        let bulletDone = false;
        for (const run of para.runs || []) {
            if (para.listType && !bulletDone) {
                const b = doc.createElement('span');
                b.textContent = para.listType === 'ol' ? '· ' : '• ';
                p.appendChild(b);
                bulletDone = true;
            }
            const span = doc.createElement(run.link ? 'a' : 'span');
            if (run.link) { span.className = 'ppv-link'; span.title = String(run.link); }
            try { span.style.cssText = run.css || ''; } catch (e) { /* noop */ }
            span.textContent = run.text != null ? String(run.text) : '';
            p.appendChild(span);
        }
        host.appendChild(p);
    }
}

function renderElement(doc, parent, el, ctx) {
    const wrap = doc.createElement('div');
    wrap.className = 'ppv-el';
    wrap.style.left = (el.left * PT_PX) + 'px';
    wrap.style.top = (el.top * PT_PX) + 'px';
    wrap.style.width = Math.max(0, el.width * PT_PX) + 'px';
    wrap.style.height = Math.max(0, el.height * PT_PX) + 'px';
    const transforms = [];
    if (el.rotate) { transforms.push(`rotate(${el.rotate}deg)`); }
    if (el.isFlipH) { transforms.push('scaleX(-1)'); }
    if (el.isFlipV) { transforms.push('scaleY(-1)'); }
    if (transforms.length) { wrap.style.transform = transforms.join(' '); }
    if (el.order !== undefined) { wrap.style.zIndex = String(el.order); }
    parent.appendChild(wrap);

    try {
        switch (el.type) {
            case 'shape': {
                if (el.path) {
                    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    const vb = el.pathViewBox || { x: 0, y: 0, width: el.width, height: el.height };
                    svg.setAttribute('viewBox', `${vb.x || 0} ${vb.y || 0} ${vb.width || el.width} ${vb.height || el.height}`);
                    svg.setAttribute('preserveAspectRatio', 'none');
                    svg.setAttribute('width', '100%');
                    svg.setAttribute('height', '100%');
                    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.setAttribute('d', el.path);
                    const f = normFill(el.fill || el.fillColor);
                    path.setAttribute('fill', el.strokeOnly ? 'none' : (typeof f === 'string' ? f : 'transparent'));
                    if (el.borderColor && el.borderWidth) {
                        path.setAttribute('stroke', normFill(el.borderColor) || '#000');
                        path.setAttribute('stroke-width', String(el.borderWidth));
                        if (el.borderType === 'dashed' || el.borderType === 'dotted') {
                            path.setAttribute('stroke-dasharray', el.strokeDasharray || '4 4');
                        }
                    }
                    svg.appendChild(path);
                    wrap.appendChild(svg);
                }
                if (el.content) { attachText(doc, wrap, el); }
                break;
            }
            case 'text': {
                const f = normFill(el.fill || el.fillColor);
                if (typeof f === 'string') { wrap.style.background = f; }
                attachText(doc, wrap, el);
                break;
            }
            case 'image': {
                const img = doc.createElement('img');
                img.style.width = '100%';
                img.style.height = '100%';
                // 移植パーサの image 要素は base64（imageMode:'base64' = data URL）/ blob フィールドで
                // 画像を運ぶ（src ではない — pptxtojson の imageDataJson 契約。TC-PPV-13 が番人）
                const src = [el.src, el.base64, el.blob].find(
                    (s) => typeof s === 'string' && (s.startsWith('data:') || s.startsWith('blob:')));
                if (src) {
                    img.src = src;
                    if (el.isFlipH || el.isFlipV) {
                        img.style.transform = `scale(${el.isFlipH ? -1 : 1}, ${el.isFlipV ? -1 : 1})`;
                    }
                    wrap.appendChild(img);
                } else {
                    placeholder(doc, wrap, ctx.label('viewerUnsupportedImageFmt', 'Image format not supported'));
                }
                break;
            }
            case 'table': {
                const table = doc.createElement('table');
                table.className = 'ppv-table';
                for (const row of el.data || []) {
                    const tr = doc.createElement('tr');
                    for (const cell of row || []) {
                        if (cell.hMerge || cell.vMerge) { continue; }
                        const td = doc.createElement('td');
                        if (cell.colSpan > 1) { td.colSpan = cell.colSpan; }
                        if (cell.rowSpan > 1) { td.rowSpan = cell.rowSpan; }
                        if (cell.fillColor) { td.style.background = normFill(cell.fillColor) || ''; }
                        renderRuns(doc, td, cell.text);
                        tr.appendChild(td);
                    }
                    table.appendChild(tr);
                }
                wrap.appendChild(table);
                break;
            }
            case 'group': {
                wrap.style.overflow = 'visible';
                for (const child of el.elements || []) { renderElement(doc, wrap, child, ctx); }
                break;
            }
            case 'chart':
                placeholder(doc, wrap, ctx.label('viewerUnsupportedChart', 'Chart (not rendered)'));
                break;
            case 'diagram': {
                // diagram.js の取得テキストがあれば表示・なければプレースホルダ（FR-PPV-04）
                if (el.content && el.content.paragraphs && el.content.paragraphs.length) { attachText(doc, wrap, el); }
                else { placeholder(doc, wrap, ctx.label('viewerUnsupportedSmartArt', 'SmartArt (not rendered)')); }
                break;
            }
            case 'math':
                placeholder(doc, wrap, ctx.label('viewerUnsupportedMath', '[equation]'));
                break;
            case 'video': case 'audio':
                placeholder(doc, wrap, el.type);
                break;
            default:
                if (el.content) { attachText(doc, wrap, el); }
                break;
        }
    } catch (e) {
        // shape 単位の失敗分離（FR-PPV-02 — スライドは生き残る）
        wrap.textContent = '';
        const box = doc.createElement('div');
        box.className = 'ppv-error-box';
        box.title = String(e && e.message ? e.message : e);
        wrap.appendChild(box);
    }
    return wrap;
}

function attachText(doc, wrap, el) {
    const tb = doc.createElement('div');
    tb.className = 'ppv-text';
    // 縦書き（FR-PPV-03）: raw vert（eaVert/vert = vertical-rl / vert270 = +180°）
    if (el.vert === 'eaVert' || el.vert === 'vert' || el.isVertical) { tb.classList.add('ppv-vert'); }
    else if (el.vert === 'vert270') { tb.classList.add('ppv-vert270'); }
    if (el.vAlign === 'mid') { tb.classList.add('ppv-valign-mid'); }
    if (el.vAlign === 'down') { tb.classList.add('ppv-valign-down'); }
    renderRuns(doc, tb, el.content);
    wrap.appendChild(tb);
}

function placeholder(doc, wrap, text) {
    const ph = doc.createElement('div');
    ph.className = 'ppv-placeholder';
    ph.textContent = text;
    wrap.appendChild(ph);
}

export function renderSlideContent(doc, slideEl, slide, ctx) {
    const bg = normFill(slide.fill);
    if (typeof bg === 'string') { slideEl.style.background = bg; }
    else if (bg && bg.image) {
        slideEl.style.backgroundImage = `url("${bg.image}")`;
        slideEl.style.backgroundSize = 'cover';
    }
    const all = [...(slide.layoutElements || []), ...(slide.elements || [])];
    for (const el of all) { renderElement(doc, slideEl, el, ctx); }
    slideEl.dataset.rendered = '1';
}

/**
 * スライド一覧を windowed で描画。
 * @returns {{ slideEls, ensureRendered(i), setScale(s), destroy() }}
 */
export function renderSlides(container, parsed, ctx) {
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    ensureStyle(doc);
    const root = doc.createElement('div');
    root.className = 'ppv-root';
    container.appendChild(root);
    const wPx = parsed.size.width * PT_PX;
    const hPx = parsed.size.height * PT_PX;
    let scale = ctx.initialScale || 1;
    const slideEls = [];
    const render = (i) => {
        const el = slideEls[i];
        if (!el || el.dataset.rendered === '1') { return; }
        try {
            renderSlideContent(doc, el, parsed.slides[i], ctx);
        } catch (e) {
            el.textContent = '';
            const box = doc.createElement('div');
            box.className = 'ppv-error-box';
            box.title = String(e && e.message ? e.message : e);
            el.appendChild(box);
            el.dataset.rendered = '1';
        }
    };
    const unrender = (i) => {
        const el = slideEls[i];
        if (!el || el.dataset.rendered !== '1') { return; }
        el.textContent = '';
        el.dataset.rendered = '0';
    };
    let io = null;
    if (win && win.IntersectionObserver) {
        io = new win.IntersectionObserver((entries) => {
            for (const entry of entries) {
                const i = Number(entry.target.dataset.idx);
                if (entry.isIntersecting) { render(i); }
                else if (Math.abs(i - lastVisible) > 2) { unrender(i); } // 可視 ±2 枚は保持
            }
        }, { root: container, rootMargin: '100% 0px' }); // 可視 ± 1 画面ぶん先行描画
    }
    let lastVisible = 0;
    const canvases = [];
    for (let i = 0; i < parsed.slides.length; i++) {
        const el = doc.createElement('div');
        el.className = 'ppv-slide';
        el.dataset.idx = String(i);
        // 内側 canvas は常に実寸（pt→px 固定座標）— 縮尺は transform: scale（再レイアウト不要）
        const canvas = doc.createElement('div');
        canvas.className = 'ppv-canvas';
        canvas.style.position = 'absolute';
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.width = wPx + 'px';
        canvas.style.height = hPx + 'px';
        canvas.style.transformOrigin = '0 0';
        canvas.dataset.rendered = '0';
        el.appendChild(canvas);
        root.appendChild(el);
        slideEls.push(canvas);   // render/unrender は canvas を対象にする
        canvases.push({ box: el, canvas });
        if (io) { io.observe(el); } else { render(i); } // IO 不在環境は全描画に縮退
    }
    function applyScale() {
        for (const { box, canvas } of canvases) {
            box.style.width = (wPx * scale) + 'px';
            box.style.height = (hPx * scale) + 'px';
            canvas.style.transform = `scale(${scale})`;
        }
    }
    applyScale();
    return {
        slideEls,
        ensureRendered(i) { lastVisible = i; render(i); },
        setScale(s) { scale = s; applyScale(); },
        getScale() { return scale; },
        destroy() { if (io) { try { io.disconnect(); } catch (e) { /* noop */ } } },
    };
}
