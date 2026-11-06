
 // ==UserScript==
 // @name         VJudge 题面 Markdown 导出器
 // @namespace    https://vjudge.net/
 // @version      0.2.0
 // @description  在 VJudge 题目页选择题面版本，复制或下载标准 Markdown，修复样例表格换行及数学公式；无需额外 CDN。
 // @author       ChatGPT
 // @match        https://vjudge.net/problem/*
 // @match        https://www.vjudge.net/problem/*
 // @run-at       document-idle
 // @grant        GM_setClipboard
 // ==/UserScript==

 (() => {
     'use strict';

     const CDN_FALLBACK = 'https://cdn.vjudge.net.cn/';
     const STATE = { refs: [], busy: false, path: '', ui: null };

     function parseJSON(raw) {
         if (!raw || !String(raw).trim()) return null;
         try { return JSON.parse(raw); } catch { return null; }
     }
     function htmlDocument(html) {
         return new DOMParser().parseFromString(html, 'text/html');
     }
     function readDataJson(doc) {
         const el = doc.querySelector('textarea[name="dataJson"]');
         return el ? parseJSON(el.value || el.textContent) : null;
     }
     function plainHtml(text) {
         const box = document.createElement('textarea');
         box.innerHTML = String(text || '');
         return box.value;
     }
     function problemKey() {
         const m = location.pathname.match(/^\/problem\/([^/?#]+)/);
         return m ? decodeURIComponent(m[1]) : '';
     }
     function getRefs(data, doc) {
         const byKey = new Map();
         const add = (item) => {
             const key = Number(item.key);
             if (!Number.isSafeInteger(key) || key <= 0) return;
             const prev = byKey.get(key) || {};
             byKey.set(key, {
                 ...prev,
                 ...Object.fromEntries(
                     Object.entries(item).filter(
                         ([k, v]) => v !== undefined && v !== ''
                     )
                 ),
                 key,
                 version: Number(item.version ?? prev.version) || 0
             });
         };
         for (const prop of [
             'descBriefs',
             'descriptions',
             'descriptionBriefs',
             'problemDescBriefs'
         ]) {
             if (!Array.isArray(data?.[prop])) continue;
             data[prop].forEach((item) => item && add(item));
         }
         doc.querySelectorAll(
             '#prob-descs [data-key], [data-version][data-key]'
         ).forEach((el) => {
             add({
                 key: el.dataset.key,
                 version: el.dataset.version,
                 lang: el.dataset.lang,
                 type: el.dataset.type,
                 author: el.dataset.author || '',
                 labelText: (el.textContent || '').trim().slice(0, 70)
             });
         });
         if (data?.descriptionId || data?.descId) {
             add({
                 key: data.descriptionId || data.descId,
                 version: 0
             });
         }
         return [...byKey.values()];
     }
     function refLabel(ref) {
         const lang = String(ref.lang || '').toLowerCase();
         const langs = {
             zh: '中文',
             en: 'English',
             ja: '日本語',
             ru: 'Русский'
         };
         const label = langs[lang] || ref.lang ||
             ref.labelText || '题面';
         const desc = ref.mainOfficial || ref.official
             ? ' · 官方'
             : ref.type === 'translator' ? ' · 翻译' : '';
         return `${label}${desc} (#${ref.key})`;
     }
     function refScore(ref) {
         const lang = String(ref.lang || '').toLowerCase();
         const label = String(ref.labelText || '');
         return (
             /^zh(?:[-_]|$)/.test(lang) ||
             /中文|简体|繁體/.test(label) ? 100 : 0
         ) + (ref.mainOfficial ? 8 : ref.official ? 5 : 0)
           + (ref.type === 'main' ? 2 : 0)
           + (lang === 'en' ? 1 : 0);
     }
     function refreshVersions() {
         if (!STATE.ui) return;
         const data = readDataJson(document);
         const refs = getRefs(data, document);
         const select = STATE.ui.select;
         const oldValue = select.value;
         const oldRefs = STATE.refs.map(r => r.key).join(',');
         const newRefs = refs.map(r => r.key).join(',');
         if (oldRefs === newRefs && select.options.length) return;
         STATE.refs = refs;
         select.replaceChildren();
         for (const ref of [...refs].sort(
             (a, b) => refScore(b) - refScore(a)
         )) {
             const opt = document.createElement('option');
             opt.value = String(ref.key);
             opt.textContent = refLabel(ref);
             select.append(opt);
         }
         if (refs.some(r => String(r.key) === oldValue)) {
             select.value = oldValue;
         }
         STATE.ui.status.textContent = refs.length
             ? `已找到 ${refs.length} 个题面版本`
             : '未找到题面版本：请先登录 VJudge 并刷新页面';
     }
     async function requestText(path) {
         const res = await fetch(path, {
             credentials: 'same-origin',
             headers: {
                 'X-Requested-With': 'XMLHttpRequest'
             },
             signal: AbortSignal.timeout(20000)
         });
         if (!res.ok) {
             throw new Error(`VJudge HTTP ${res.status}`);
         }
         if (
             res.redirected &&
             /[?&]login=1|\/user\/login/.test(res.url)
         ) {
             throw new Error(
                 '登录已失效，请在 VJudge 网页重新登录'
             );
         }
         return res.text();
     }
     async function cdnBase() {
         try {
             const cfg = parseJSON(
                 await requestText('/util/cfg')
             );
             const base = cfg?.cdnBaseUrl;
             if (
                 typeof base === 'string' &&
                 /^https?:\/\//i.test(base)
             ) {
                 return base.replace(/\/?$/, '/');
             }
         } catch {
             // 使用默认 CDN
         }
         return CDN_FALLBACK;
     }
     function readPayload(raw) {
         const json = parseJSON(raw);
         if (json) return json;
         const doc = htmlDocument(raw);
         const els = [
             ...doc.querySelectorAll(
                 'textarea.data-json-container, ' +
                 'textarea[name="dataJson"], textarea'
             )
         ];
         for (const el of els) {
             const obj = parseJSON(
                 el.value || el.textContent
             );
             if (obj) return obj;
         }
         return null;
     }
     function replaceCdn(source, cdn) {
         return String(source || '').replace(
             /CDN_BASE_URL\//g, cdn
         );
     }
     function safeUrl(uri, cdn) {
         const s = replaceCdn(uri, cdn).trim();
         if (
             !s ||
             /^(?:javascript|data|vbscript):/i.test(s)
         ) return '';
         try {
             const url = new URL(
                 s, 'https://vjudge.net/'
             );
             return /^https?:$/.test(url.protocol)
                 ? url.href : '';
         } catch {
             return '';
         }
     }
     function mathToDollars(value) {
         if (value.startsWith('\\(')) {
             return '$' + value.slice(2, -2) + '$';
         }
         if (value.startsWith('\\[')) {
             return '\n\n$$\n' +
                 value.slice(2, -2).trim() +
                 '\n$$\n\n';
         }
         return value;
     }
     // 将正文数学公式转成 Markdown 常用的 $...$ 格式。
     // 不修改代码块内部的内容。
     function normalizeMarkdownMath(markdown) {
         let inFence = false;
         let fenceChar = '';
         let fenceLength = 0;
         const lines = String(markdown).split('\n');
         return lines.map(line => {
             const match = line.match(
                 /^\s*(`{3,}|~{3,})/
             );
             if (match) {
                 if (!inFence) {
                     inFence = true;
                     fenceChar = match[1][0];
                     fenceLength = match[1].length;
                 } else if (
                     match[1][0] === fenceChar &&
                     match[1].length >= fenceLength
                 ) {
                     inFence = false;
                 }
                 return line;
             }
             if (inFence) return line;
             return line.split(/(`+[^`]*`+)/g)
                 .map((part, i) => i % 2 ? part :
                     part.replace(
                         /\\\((.+?)\\\)/g,
                         (_, body) => '$' + body + '$'
                     ).replace(
                         /\\\[(.+?)\\\]/g,
                         (_, body) => '$$' + body + '$$'
                     )
                 ).join('');
         }).join('\n');
     }
     function protectMath(value) {
         const math = [];
         const regex =
             /(\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\n])+?(?<!\\)\$)/g;
         let text = String(value || '').replace(
             regex,
             found => {
                 const id = math.length;
                 math.push(mathToDollars(found));
                 return `\uE000${id}\uE001`;
             }
         );
         text = text.replace(/\u00a0/g, ' ')
             .replace(/[\t\r\n ]+/g, ' ')
             .replace(/\\/g, '\\\\')
             .replace(/([*_`\[\]])/g, '\\$1');
         return text.replace(
             /\uE000(\d+)\uE001/g,
             (_, id) => math[Number(id)]
         );
     }
     function htmlToMarkdown(
         html, cdn, contextTitle = ''
     ) {
         const template = document.createElement(
             'template'
         );
         template.innerHTML = replaceCdn(html, cdn);
         template.content.querySelectorAll(
             'script,style,noscript,iframe,form,button'
         ).forEach(n => n.remove());

         const formatFence = (
             code, language = 'text'
         ) => {
             const value = String(code)
                 .replace(/\r\n?/g, '\n')
                 .replace(/^\n+|\n+$/g, '');
             const ticks = Math.max(
                 2,
                 ...[...value.matchAll(/`+/g)]
                     .map(x => x[0].length)
             );
             const fence = '`'.repeat(ticks + 1);
             return `${fence}${language}\n${value}\n${fence}`;
         };

         const inline = node => {
             if (node.nodeType === Node.TEXT_NODE) {
                 return protectMath(node.nodeValue);
             }
             if (node.nodeType !== Node.ELEMENT_NODE) {
                 return '';
             }
             const tag = node.tagName.toLowerCase();
             const inside = () =>
                 [...node.childNodes].map(inline).join('');

             if (tag === 'br') return '  \n';
             if (tag === 'img') {
                 const url = safeUrl(
                     node.getAttribute('src') ||
                     node.getAttribute('data-src'), cdn
                 );
                 const alt = String(
                     node.getAttribute('alt') || ''
                 ).replace(/[\[\]]/g, '');
                 return url ? `![${alt}](${url})` : '';
             }
             if (tag === 'a') {
                 const name = inside().trim();
                 const url = safeUrl(
                     node.getAttribute('href'), cdn
                 );
                 return url
                     ? `[${name || url}](${url})`
                     : name;
             }
             if (tag === 'code') {
                 const code = node.textContent || '';
                 const ticks = Math.max(
                     0,
                     ...[...code.matchAll(/`+/g)]
                         .map(x => x[0].length)
                 );
                 const mark = '`'.repeat(ticks + 1);
                 return `${mark}${code}${mark}`;
             }
             if (tag === 'strong' || tag === 'b') {
                 return `**${inside().trim()}**`;
             }
             if (tag === 'em' || tag === 'i') {
                 return `*${inside().trim()}*`;
             }
             if (tag === 'del' || tag === 's') {
                 return `~~${inside().trim()}~~`;
             }
             if (tag === 'sup' || tag === 'sub') {
                 return `<${tag}>${inside()}</${tag}>`;
             }
             if (tag === 'math') {
                 return mathToDollars(
                     node.getAttribute('alttext') ||
                     node.textContent || ''
                 );
             }
             return inside();
         };

         const isBlock = node =>
             node.nodeType === Node.ELEMENT_NODE &&
             /^(h[1-6]|p|pre|div|section|article|ul|ol|li|table|blockquote|hr)$/
                 .test(node.tagName.toLowerCase());

         const children = root => {
             const parts = [];
             let buf = '';
             const flush = () => {
                 if (buf.trim()) {
                     parts.push(buf.trim());
                 }
                 buf = '';
             };
             for (const node of root.childNodes) {
                 if (isBlock(node)) {
                     flush();
                     const converted = block(node);
                     if (converted.trim()) {
                         parts.push(converted.trim());
                     }
                 } else {
                     buf += inline(node);
                 }
             }
             flush();
             return parts.join('\n\n');
         };

         const list = (root, ordered) =>
             [...root.children]
                 .filter(el =>
                     el.tagName?.toLowerCase() === 'li'
                 )
                 .map((li, i) => {
                     const nested = [...li.children]
                         .filter(el =>
                             /^(ul|ol)$/i.test(el.tagName)
                         );
                     const clone = li.cloneNode(true);
                     clone.querySelectorAll(
                         'ul,ol'
                     ).forEach(el => el.remove());
                     const head = inline(clone)
                         .trim().replace(/\n/g, ' ');
                     const tail = nested.map(el =>
                         list(
                             el,
                             el.tagName.toLowerCase() === 'ol'
                         ).split('\n')
                          .map(line =>
                              line ? '  ' + line : ''
                          ).join('\n')
                     ).join('\n');
                     return (
                         ordered ? `${i + 1}. ` : '- '
                     ) + head + (
                         tail ? '\n' + tail : ''
                     );
                 }).join('\n');

         // 样例输入输出需要保留原始换行
         const rawCellText = cell => {
             const pres = [
                 ...cell.querySelectorAll('pre')
             ];
             if (pres.length) {
                 return pres.map(
                     el => el.textContent || ''
                 ).join('\n')
                  .replace(/\r\n?/g, '\n')
                  .trim();
             }
             const walk = node => {
                 if (node.nodeType === Node.TEXT_NODE) {
                     return node.nodeValue || '';
                 }
                 if (node.nodeType !== Node.ELEMENT_NODE) {
                     return '';
                 }
                 const tag = node.tagName.toLowerCase();
                 if (tag === 'br') return '\n';
                 const content = [...node.childNodes]
                     .map(walk).join('');
                 return /^(p|div|li)$/.test(tag)
                     ? content + '\n'
                     : content;
             };
             return walk(cell)
                 .replace(/\r\n?/g, '\n')
                 .replace(/^\n+|\n+$/g, '')
                 .trim();
         };

         // 将 Input | Output 表格识别成独立代码块
         const table = root => {
             const rows = [
                 ...root.querySelectorAll('tr')
             ].map(tr =>
                 [...tr.children].filter(td =>
                     /^(td|th)$/i.test(td.tagName)
                 )
             );
             if (!rows.length) return '';

             const headers = rows[0].map(cell =>
                 (cell.textContent || '')
                     .trim().toLowerCase()
             );
             const inputIndex = headers.findIndex(x =>
                 /^(sample\s*)?(input|输入|样例输入|输入样例)(\s*\d+)?$/
                     .test(x)
             );
             const outputIndex = headers.findIndex(x =>
                 /^(sample\s*)?(output|输出|样例输出|输出样例)(\s*\d+)?$/
                     .test(x)
             );

             if (
                 inputIndex !== -1 &&
                 outputIndex !== -1 &&
                 rows.length >= 2
             ) {
                 const match = String(
                     contextTitle
                 ).match(
                     /(?:样例|示例|sample|example)\s*(\d+)/i
                 );
                 const startingIndex = match
                     ? Number(match[1]) : 1;

                 return rows.slice(1)
                     .map((cells, index) => {
                         const num = startingIndex + index;
                         const input = rawCellText(
                             cells[inputIndex] ||
                             document.createElement('td')
                         );
                         const output = rawCellText(
                             cells[outputIndex] ||
                             document.createElement('td')
                         );
                         return (
                             `### 样例输入 ${num}\n\n` +
                             `${formatFence(input)}\n\n` +
                             `### 样例输出 ${num}\n\n` +
                             formatFence(output)
                         );
                     }).join('\n\n');
             }

             // 普通表格仍然输出 Markdown 表格
             const values = rows.map(cells =>
                 cells.map(cell => {
                     const pre = cell.querySelector('pre');
                     const content = pre
                         ? rawCellText(cell)
                         : inline(cell);
                     return content.trim()
                         .replace(/\r?\n/g, '<br>')
                         .replace(/\|/g, '\\|');
                 })
             );
             const cols = Math.max(
                 ...values.map(row => row.length)
             );
             const row = cells =>
                 '| ' + Array.from(
                     { length: cols },
                     (_, i) => cells[i] || ''
                 ).join(' | ') + ' |';
             return [
                 row(values[0]),
                 row(Array(cols).fill('---')),
                 ...values.slice(1).map(row)
             ].join('\n');
         };

         const block = node => {
             const tag = node.tagName.toLowerCase();
             if (/^h[1-6]$/.test(tag)) {
                 return (
                     '#'.repeat(Number(tag[1]) + 1) +
                     ' ' + inline(node).trim()
                 );
             }
             if (tag === 'p' || tag === 'li') {
                 return inline(node).trim();
             }
             if (tag === 'ul' || tag === 'ol') {
                 return list(node, tag === 'ol');
             }
             if (tag === 'pre') {
                 const lang = node.querySelector(
                     'code'
                 )?.className?.match(
                     /(?:lang|language)-([\w+.-]+)/
                 )?.[1] || 'text';

                 let code = node.textContent || '';

                 // 输入格式中的 LaTeX 占位符
                 if (
                     /^(输入|输入格式|input|input format)$/i
                         .test(contextTitle.trim())
                 ) {
                     code = code.replace(
                         /\\\((.*?)\\\)/g,
                         (_, value) =>
                             value.replace(/\s*_\s*/g, '_')
                     ).replace(/\\vdots/g, '⋮');
                 }
                 return formatFence(code, lang);
             }
             if (tag === 'table') {
                 return table(node);
             }
             if (tag === 'hr') return '---';
             if (tag === 'blockquote') {
                 return children(node)
                     .split('\n')
                     .map(line => '> ' + line)
                     .join('\n');
             }
             return children(node);
         };

         return normalizeMarkdownMath(
             children(template.content)
         ).trim();
     }

     function isMarkdown(format) {
         return /^(md|markdown|mdown)$/i.test(
             String(format || '').trim()
         ) || /markdown/i.test(
             String(format || '')
         );
     }

     function sectionToMarkdown(section, cdn) {
         const val = section?.value || {};
         let text = typeof val === 'string'
             ? val : val.content;
         if (
             typeof text !== 'string' ||
             !text.trim()
         ) return '';

         text = replaceCdn(text, cdn);
         const title = plainHtml(
             section.title || ''
         ).replace(/[\r\n]+/g, ' ').trim();

         const body = isMarkdown(val.format)
             ? normalizeMarkdownMath(text.trim())
             : htmlToMarkdown(text, cdn, title);

         return (
             title ? `## ${title}\n\n` : ''
         ) + body;
     }

     function payloadToMarkdown(payload, cdn) {
         if (Array.isArray(payload?.sections)) {
             const out = payload.sections
                 .map(s => sectionToMarkdown(s, cdn))
                 .filter(Boolean);

             const pre =
                 typeof payload.prependHtml === 'string'
                     ? htmlToMarkdown(
                         payload.prependHtml, cdn
                     )
                     : '';
             if (pre.trim()) out.unshift(pre);
             if (out.length) return out.join('\n\n');
         }
         const legacy =
             typeof payload === 'string'
                 ? payload
                 : payload?.description || payload?.content;
         if (
             typeof legacy === 'string' &&
             legacy.trim()
         ) {
             return htmlToMarkdown(legacy, cdn);
         }
         return '';
     }

     function cleanFilename(name) {
         return String(name).replace(
             /[\\/:*?"<>|\u0000-\u001f]/g, '_'
         ).slice(0, 130);
     }

     async function buildMarkdown() {
         const key = problemKey();
         if (!key) {
             throw new Error('请打开 VJudge 题目页');
         }
         refreshVersions();

         const ref = STATE.refs.find(
             r => String(r.key) === STATE.ui.select.value
         );
         if (!ref) {
             throw new Error(
                 '找不到题面版本，请确认已登录 VJudge 并刷新页面'
             );
         }

         const data = readDataJson(document) || {};
         const version = ref.version
             ? `?${encodeURIComponent(ref.version)}`
             : '';
         const raw = await requestText(
             `/problem/description/${ref.key}${version}`
         );
         const payload = readPayload(raw);

         if (!payload) {
             throw new Error(
                 '题面接口没有返回可解析的 JSON；' +
                 '请在开发者工具 Network 查看响应'
             );
         }

         const body = payloadToMarkdown(
             payload, await cdnBase()
         );
         if (body.length < 10) {
             throw new Error(
                 '题面内容为空或格式已改变，请尝试切换其他版本'
             );
         }

         const title = (
             typeof data.title === 'string' &&
             data.title.trim()
         ) || document.querySelector(
             '#problem-title, .problem-title'
         )?.textContent?.trim() || key;

         const link =
             `https://vjudge.net/problem/${encodeURIComponent(key)}`;

         const header =
             `# ${title.replace(/[\r\n]+/g, ' ')}\n\n` +
             `> 来源：${key}  \n` +
             `> 原题链接：${link}  \n` +
             `> 题面版本：${refLabel(ref)}\n\n`;

         return {
             text: header + body.trim() + '\n',
             filename: cleanFilename(key) + '.md'
         };
     }

     function status(message, error = false) {
         if (!STATE.ui) return;
         STATE.ui.status.textContent = message;
         STATE.ui.status.style.color = error
             ? '#fca5a5'
             : '#a7f3d0';
     }

     async function run(action) {
         if (STATE.busy) return;
         STATE.busy = true;

         STATE.ui.copy.disabled = true;
         STATE.ui.download.disabled = true;
         status('正在读取题面…');

         try {
             const { text, filename } =
                 await buildMarkdown();

             if (action === 'copy') {
                 if (
                     typeof GM_setClipboard === 'function'
                 ) {
                     GM_setClipboard(text, 'text');
                 } else {
                     await navigator.clipboard.writeText(text);
                 }
                 status(
                     `复制成功 · ${text.length} 字符`
                 );
             } else {
                 const file = new Blob(
                     ['\uFEFF', text],
                     {
                         type: 'text/markdown;charset=utf-8'
                     }
                 );
                 const url =
                     URL.createObjectURL(file);

                 const a = document.createElement('a');
                 a.href = url;
                 a.download = filename;
                 document.body.append(a);
                 a.click();
                 a.remove();

                 setTimeout(
                     () => URL.revokeObjectURL(url),
                     30000
                 );
                 status(`已生成 ${filename}`);
             }
         } catch (e) {
             console.error(
                 '[VJudge Markdown Exporter]', e
             );
             status(
                 e?.message || String(e), true
             );
         } finally {
             STATE.ui.copy.disabled = false;
             STATE.ui.download.disabled = false;
             STATE.busy = false;
         }
     }

     function mount() {
         if (STATE.ui || !document.body) return;

         const host = document.createElement('div');
         host.id = 'vj-markdown-export';
         host.style.cssText =
             'position:fixed;right:16px;bottom:18px;' +
             'z-index:2147483646;';

         const shadow = host.attachShadow({
             mode: 'open'
         });

         shadow.innerHTML = `
           <style>
             * {box-sizing:border-box}
             .panel{
               width:270px;
               padding:12px;
               background:#111827;
               color:#f9fafb;
               border:1px solid #374151;
               border-radius:12px;
               box-shadow:0 8px 28px #0006;
               font:13px/1.5 system-ui,-apple-system,sans-serif
             }
             .title{
               font-weight:700;
               font-size:14px;
               margin-bottom:8px;
               display:flex;
               align-items:center;
               justify-content:space-between
             }
             select,button{
               font:inherit;
               border-radius:7px;
               min-height:33px
             }
             select{
               width:100%;
               padding:4px 8px;
               background:#1f2937;
               color:#f9fafb;
               border:1px solid #4b5563
             }
             .actions{
               display:flex;
               gap:8px;
               margin-top:9px
             }
             button{
               cursor:pointer;
               padding:5px 10px;
               border:1px solid #4b5563;
               background:#374151;
               color:white
             }
             button.primary{
               background:#2563eb;
               border-color:#2563eb
             }
             button:disabled{
               opacity:.5;
               cursor:wait
             }
             .actions button{flex:1}
             #status{
               font-size:11px;
               margin-top:8px;
               color:#a7f3d0;
               overflow-wrap:anywhere
             }
             .close{
               border:none;
               background:transparent;
               font-size:19px;
               min-height:20px;
               line-height:1;
               padding:0 4px
             }
           </style>
           <div class="panel" id="panel">
             <div class="title">
               <span>VJudge → Markdown</span>
               <button class="close" id="hide" title="收起面板">×</button>
             </div>
             <select id="versions" aria-label="题面版本"></select>
             <div class="actions">
               <button id="copy" class="primary">复制 Markdown</button>
               <button id="download">下载 .md</button>
             </div>
             <div id="status">正在读取题面版本…</div>
           </div>
           <button id="reopen"
             style="display:none;background:#2563eb">
             MD 导出
           </button>`;

         document.body.append(host);

         STATE.ui = {
             host,
             select: shadow.querySelector('#versions'),
             copy: shadow.querySelector('#copy'),
             download: shadow.querySelector('#download'),
             status: shadow.querySelector('#status')
         };

         STATE.ui.copy.addEventListener(
             'click', () => run('copy')
         );
         STATE.ui.download.addEventListener(
             'click', () => run('download')
         );

         shadow.querySelector('#hide')
             .addEventListener('click', () => {
                 shadow.querySelector(
                     '#panel'
                 ).style.display = 'none';
                 shadow.querySelector(
                     '#reopen'
                 ).style.display = '';
             });

         shadow.querySelector('#reopen')
             .addEventListener('click', () => {
                 shadow.querySelector(
                     '#panel'
                 ).style.display = '';
                 shadow.querySelector(
                     '#reopen'
                 ).style.display = 'none';
             });

         refreshVersions();
         STATE.path = location.pathname;

         // 处理题面异步加载和站内导航
         setInterval(() => {
             if (location.pathname !== STATE.path) {
                 STATE.path = location.pathname;
                 STATE.refs = [];
             }
             if (
                 !STATE.busy &&
                 STATE.refs.length === 0
             ) {
                 refreshVersions();
             }
         }, 1200);
     }

     if (document.readyState === 'loading') {
         document.addEventListener(
             'DOMContentLoaded',
             mount,
             { once: true }
         );
     } else {
         mount();
     }
 })();
