// ==UserScript==
// @name         CANNLab 自动启动
// @namespace    local.cannlab
// @version      2.3.0
// @description  持续监守 
// @match        https://gitcode.com/org/cann/cannlab/environment*
// @include      https://gitcode.com/?tn=cannlab-environment*
// @run-at       document-idle
// @grant        GM_audio
// @grant        GM_notification
// @noframes
// @license MIT
// @downloadURL https://raw.githubusercontent.com/aik4o/cannlab-autostart/main/cannlab-autostart.user.js
// @updateURL https://raw.githubusercontent.com/aik4o/cannlab-autostart/main/cannlab-autostart.user.js
// ==/UserScript==

(() => {
  'use strict';
  const POLL_MS = 2_000, RETRY_MS = 60_000, ACK_MS = 120_000;

  // 环境页有两个入口：旧版 /org/cann/cannlab/environment，新版首页 ?tn=cannlab-environment。
  function isEnvPage(loc) {
    if (loc.pathname.replace(/\/$/, '') === '/org/cann/cannlab/environment') return true;
    return loc.pathname === '/' && new URLSearchParams(loc.search).get('tn') === 'cannlab-environment';
  }

  // 目标名称解析：中英文逗号分隔，忽略全部空白字符，按输入顺序去重。
  function parseTargets(input) {
    return [...new Set(input.split(/[,，]/).map(s => s.replace(/\s+/g, '')).filter(Boolean))];
  }

  // 纯规则：测试和浏览器共用；不会把灰色的“连接”当成成功。
  function decide(view, run, now) {
    if (view.error) return {blocked: true, wait: `${view.error}；暂停操作，继续检查`};
    if (view.loading) return {wait: '等待页面加载'};
    if (view.dialog) {
      const pending = run.pending;
      const expected = pending && view.dialog.title === `${pending.action}实例`
        && view.dialog.body === `确认${pending.action}实例「${run.target}」吗？`;
      if (!expected) return {blocked: true, wait: `等待弹窗关闭或内容就绪，暂不点击。标题：${view.dialog.title || '（无）'}；正文：${view.dialog.body || view.dialog.text || '（无）'}`};
      if (run.stopping && pending.action === '启动') {
        return view.dialog.cancel ? {cancel: true, wait: '已到结束时间，取消启动确认'}
          : {wait: '已到结束时间，等待启动请求返回后关机'};
      }
      if (pending.confirmed && view.dialog.enabled && view.status === pending.status
        && (view.resourceError || pending.busy) && view.dialog.cancel) {
        return {cancel: true, wait: view.resourceError || '启停请求返回后状态未变，关闭确认框，稍后重试'};
      }
      // 资源不足时确认框可能留在原地；状态未变且按钮恢复可用后，刷新核实再重试。
      if (pending.confirmed && now - pending.at >= ACK_MS && view.dialog.enabled
        && view.status === pending.status && ['已关机', '异常', ...(run.stopping ? ['运行中'] : [])].includes(view.status)) {
        return {reload: true, wait: '启停确认后状态持续未变，刷新页面重新检查并重试'};
      }
      // 已进入处理阶段或按钮仍禁用时，不因后台定时器延迟而重复确认。
      if (pending.confirmed && now - pending.at >= ACK_MS) return {blocked: true, wait: '已发送启停确认，等待确认框关闭；若持续不变，请检查弹窗内容'};
      if (pending.confirmed || !view.dialog.enabled) return {wait: '等待确认框处理完成'};
      return {confirm: pending.action};
    }
    // 页面会显示“正在分配资源... / 正在配置网络... / 正在挂载存储...”。
    // 这些中间阶段与点击冷却时间无关；即使后台确认延迟，也只能继续等待。
    if (/^正在/.test(view.status) || ['启动中', '开机中', '关机中', '停止中', '排队中'].includes(view.status)) {
      return {wait: `当前状态：${view.status}，等待处理完成`};
    }
    if (run.stopping) {
      // 启动请求已提交时，关机前先等原请求落定，避免把暂时的“已关机”当成完成。
      if (run.pending?.confirmed && run.pending.action === '启动' && now - run.pending.at < ACK_MS) {
        return {wait: '等待已提交的启动请求落定后关机'};
      }
      if (view.status === '已关机') return {done: true, wait: '定时任务完成：目标环境已关机'};
      if (run.pending?.action === '关机' && run.pending.status === view.status && now - run.pending.at < ACK_MS) {
        return {wait: '已请求关机，等待状态改变'};
      }
      if (now < run.nextActionAt) return {wait: '等待关机重试间隔'};
      if (['运行中', '异常'].includes(view.status) && view.shutdown) return {action: '关机'};
      return {blocked: true, wait: `定时关机：当前状态“${view.status || '（空）'}”，等待关机按钮可用`};
    }
    if (view.connect && view.status === '运行中') {
      return {ready: true, wait: '环境已可连接，持续监守'};
    }
    if (run.pending && run.pending.status === view.status && now - run.pending.at < ACK_MS) {
      return {wait: `已点击${run.pending.action}，等待状态改变`};
    }
    if (now < run.nextActionAt) return {wait: '等待重试间隔'};
    if (view.status === '已关机' && view.start) return {action: '启动'};
    if (view.status === '异常' && view.shutdown) return {action: '关机'};
    if (['已关机', '异常', '运行中'].includes(view.status)) {
      return {wait: `当前状态：${view.status}，等待按钮可用`};
    }
    return {blocked: true, wait: `暂未识别状态“${view.status || '（空）'}”，暂停启停，继续等待状态更新`};
  }

  // 规格标签（CPU / NPU A2 / NPU A3 / 950）：页面在环境名称容器里渲染 <em class="tone">标签</em>。
  function readSpec(row) {
    const em = row.querySelector('.env-name em, .environment-mobile-card__name em');
    const text = em?.textContent.trim();
    if (text) return text;
    // 兜底：名称容器之外查找形如 CPU / NPU A2 / NPU A3 / 950 的短标签。
    for (const e of row.querySelectorAll('*')) {
      if (e.closest?.('.env-name, .environment-mobile-card__name')) continue;
      if (e.children.length) continue;
      const t = e.textContent.trim();
      if (/^(CPU|NPU A\d|950)$/.test(t)) return t;
    }
    return '';
  }

  // 扫描一次页面，返回每个目标的视图（互不含 DOM 元素，可安全随 run 持久化的是 targets，不是这里的结果）。
  function readViews(doc, targets) {
    const visible = e => !!e && e.getClientRects().length > 0 && doc.defaultView.getComputedStyle(e).visibility !== 'hidden';
    const counts = new Map(), rowsByName = new Map();
    for (const row of [...doc.querySelectorAll('.env-table .table-row, .environment-mobile-card')].filter(visible)) {
      const name = row.querySelector('.env-name > span, .environment-mobile-card__name > span')?.textContent.trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
      if (!rowsByName.has(name)) rowsByName.set(name, row);
    }
    // 关闭动画尚未卸载的弹窗仍有布局尺寸，但已经不是当前待处理弹窗。
    const dialogs = [...doc.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter(visible).filter(e => e.getAttribute('data-state') !== 'closed' && e.getAttribute('aria-hidden') !== 'true');
    const dialogElement = dialogs.length === 1 ? dialogs[0] : null;
    const dialogInfo = dialogs.length > 1
      ? {text: `页面有多个弹窗：${dialogs.map(e => e.textContent.trim().slice(0,200)).join('；')}`}
      : dialogElement ? readDialogInfo(dialogElement, visible) : null;
    const resourceError = [...doc.querySelectorAll('[role="alert"], [role="status"], li')]
      .filter(visible).find(e => !e.closest?.('#cannlab-auto-start-panel') && /当前资源不足[，,]?\s*请稍后重试/.test(e.textContent))?.textContent.trim();
    const views = new Map();
    for (const target of targets) {
      const count = counts.get(target) || 0;
      if (count !== 1) {
        views.set(target, {error: `找到 ${count} 个同名环境：${target}。请检查名称、搜索条件和筛选项`});
        continue;
      }
      const row = rowsByName.get(target);
      const buttons = [...row.querySelectorAll('button')].filter(visible);
      const enabled = label => buttons.filter(b => b.textContent.trim() === label && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      const controls = {start: enabled('启动'), shutdown: enabled('关机'), connect: enabled('连接')};
      if (Object.values(controls).some(items => items.length > 1)) {
        views.set(target, {error: '目标行按钮重复'});
        continue;
      }
      // 确认框正文带「环境名」：归属明确时只交给属主；无归属的外来弹窗交给所有目标，由 decide 判定暂不点击。
      const ownerName = dialogInfo?.body ? (targets.find(n => dialogInfo.body.includes(`「${n}」`)) ?? null) : null;
      const own = dialogInfo && (ownerName === target || ownerName === null) ? dialogInfo : null;
      views.set(target, {
        resourceError,
        spec: readSpec(row),
        status: row.querySelector('.status-text')?.textContent.trim() || '',
        start: controls.start.length === 1, shutdown: controls.shutdown.length === 1, connect: controls.connect.length === 1,
        dialog: own,
        buttons: {启动: controls.start[0], 关机: controls.shutdown[0],
          confirm: own ? dialogInfo.confirmButton : null, cancel: own ? dialogInfo.cancelButton : null,
          连接: controls.connect[0] || null},
      });
    }
    return {views, dialogInfo, dialogElement, allNames: [...counts.keys()]};
  }

  function readDialogInfo(dialog, visible) {
    const title = dialog.querySelector('.power-confirm-modal__title')?.textContent.trim();
    const confirmButtons = [...dialog.querySelectorAll('button')]
      .filter(b => !b.closest?.('#cannlab-auto-start-panel') && visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
        && `${b.textContent.trim()}实例` === title && ['启动', '关机'].includes(b.textContent.trim()));
    const cancelButtons = [...dialog.querySelectorAll('button')]
      .filter(b => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b.textContent.trim() === '取消');
    return {
      title,
      body: dialog.querySelector('.power-confirm-modal__body')?.textContent.trim(),
      text: dialog.textContent.trim().slice(0,500),
      enabled: confirmButtons.length === 1,
      cancel: cancelButtons.length === 1,
      confirmButton: confirmButtons[0] || null,
      cancelButton: cancelButtons[0] || null,
    };
  }

  // MutationObserver 专用：只找当前弹窗，避免每次 DOM 变动都做全表扫描。
  function findDialogElement(doc) {
    const visible = e => !!e && e.getClientRects().length > 0 && doc.defaultView.getComputedStyle(e).visibility !== 'hidden';
    const dialogs = [...doc.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter(visible).filter(e => e.getAttribute('data-state') !== 'closed' && e.getAttribute('aria-hidden') !== 'true');
    return dialogs.length === 1 ? dialogs[0] : null;
  }

  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = {decide, readViews, readSpec, parseTargets, isEnvPage};
    return;
  }
  // @match/@include 之外的页面（含 SPA 软导航后的地址）一律不运行。
  if (!isEnvPage(location)) return;
  const ID = 'cannlab-auto-start-panel', KEY = 'cannlab-auto-start-v1';
  if (document.getElementById(ID)) return;
  const loadedAt = Date.now();
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { /* 使用初始状态。 */ }
  // v2 起为多目标结构；旧版单目标存档不迁移，直接按初始状态开始。
  const savedOk = saved && Array.isArray(saved.targets) && saved.targets.length > 0
    && saved.targets.every(t => t && typeof t.target === 'string');
  let run = savedOk ? saved : {running: false, targets: [], logs: []};
  run.running = run.running === true;
  delete run.target;
  delete run.pending;
  delete run.deadline;
  delete run.minutes;
  delete run.settingsVersion;
  delete run.lastBlocked;
  delete run.lastStatus;
  run.targets = run.targets.map(t => ({pending: null, nextActionAt: 0, ready: false, successAt: null, attempts: 0, ...t}));
  let timer, audioReady = false, minimized = run.minimized === true;
  const panel = document.createElement('section');
  panel.id = ID;
  panel.style.cssText = 'position:fixed;right:20px;bottom:24px;z-index:2147483647;width:min(360px,calc(100vw - 40px));box-sizing:border-box;padding:16px;background:#fff;color:#17212f;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 4px 24px #0002;font:14px/1.5 system-ui;';
  panel.style.pointerEvents = 'auto';
  panel.innerHTML = `<style>
    #${ID} input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#17212f;font:inherit;min-width:0}
    #${ID} button{padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;color:#17212f;font:inherit;cursor:pointer;white-space:nowrap}
    #${ID} button:disabled{opacity:.45;cursor:default}
    #${ID} button[data-action="start"]{background:#2563eb;border-color:#2563eb;color:#fff}
    #${ID} [data-field="header"]{display:flex;align-items:center;gap:8px}
    #${ID} [data-field="header"] strong{flex:1}
    #${ID} [data-field="dot"]{width:10px;height:10px;border-radius:50%;background:#94a3b8;flex:none}
    #${ID} [data-field="targets"] > div{display:flex;align-items:center;gap:6px;padding:2px 0}
    #${ID} [data-field="targets"] > div > span{flex:1;overflow-wrap:anywhere}
    #${ID} [data-field="targets"] button{padding:1px 8px;font-size:12px;line-height:1.6;flex:none}
  </style><header data-field="header"><strong>CANNLab 自动启动 v2.3.0</strong><span data-field="dot" title="尚未检查"></span><button type="button" data-action="minimize" title="最小化面板">—</button></header>
    <div data-field="body"><label style="display:block;margin-top:10px">目标环境（多个用逗号分隔） <input data-field="target" placeholder="例如：env-a, env-b，env-c"></label>
    <label style="display:block;margin-top:10px">定时启动 <input type="datetime-local" data-field="startAt"></label>
    <label style="display:block;margin-top:10px">定时关闭服务器 <input type="datetime-local" data-field="stopAt"></label>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      <button type="button" data-action="inspect">检查状态</button>
      <button type="button" data-action="start">启动</button>
      <button type="button" data-action="stop">停止</button>
    </div>
    <div data-field="status" aria-live="off" style="margin-top:12px;padding:10px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere"></div>
    <div data-field="targets" style="margin-top:10px;padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;display:none"></div>
    <pre aria-live="off" style="white-space:pre-wrap;overflow:auto;max-height:160px;font:12px/1.6 system-ui;margin-bottom:0"></pre></div>`;
  document.body.append(panel);
  const targetInput = panel.querySelector('[data-field="target"]');
  const startButton = panel.querySelector('[data-action="start"]');
  const stopButton = panel.querySelector('[data-action="stop"]');
  const startAtInput = panel.querySelector('[data-field="startAt"]');
  const stopAtInput = panel.querySelector('[data-field="stopAt"]');
  const statusLabel = panel.querySelector('[data-field="status"]');
  const targetListData = panel.querySelector('[data-field="targets"]');
  const bodyBox = panel.querySelector('[data-field="body"]');
  const dot = panel.querySelector('[data-field="dot"]');
  const minimizeButton = panel.querySelector('[data-action="minimize"]');
  const localTime = at => {
    if (!at) return '';
    const date = new Date(at);
    return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  targetInput.value = run.targets.map(t => t.target).join(', ');
  startAtInput.value = localTime(run.startAt);
  stopAtInput.value = localTime(run.stopAt);
  let liveStatus = run.running ? '正在恢复监守' : run.logs.length ? '监守已停止' : '尚未开始';
  let checkedAt = 0, snapshotTargets = [];
  function refreshStatus() {
    let names = run.running && run.targets.length ? run.targets.map(t => t.target) : parseTargets(targetInput.value);
    let scan = readViews(document, names);
    // 默认自动读取：未运行且目标为空时，把页面上当前的全部环境填入目标。
    if (!run.running && !names.length && scan.allNames.length) {
      targetInput.value = scan.allNames.join(', ');
      names = scan.allNames.slice();
      scan = readViews(document, names);
    }
    checkedAt = Date.now();
    snapshotTargets = names.map(n => {
      const v = scan.views.get(n);
      if (!v) return {name: n, line: `${n}：等待扫描`, ready: false};
      if (v.error) return {name: n, line: `${n}：${v.error}`, ready: false};
      const state = run.targets.find(t => t.target === n);
      const spec = state?.spec || v.spec ? `（${state?.spec || v.spec}）` : '';
      let line = `${n}${spec}：${v.status || '等待加载'}`;
      if (run.running && state?.ready) line += `；✓ 可连接${state.successAt ? `（${new Date(state.successAt).toLocaleTimeString()}）` : ''}`;
      if (run.running && state?.pending) line += `；已点击${state.pending.action}`;
      if (run.running && state?.done) line += '；已关机';
      return {name: n, line, ready: !!(run.running && state?.ready && v.connect)};
    });
    render();
  }
  // 按最小化状态和所在容器（页面或弹窗）套用面板外观；宽度统一在这里决定。
  function applyPanelSkin() {
    const inDialog = panel.parentNode !== document.body;
    bodyBox.style.display = minimized ? 'none' : '';
    minimizeButton.textContent = minimized ? '展开' : '—';
    minimizeButton.title = minimized ? '恢复面板' : '最小化面板';
    Object.assign(panel.style, minimized
      ? {width: 'auto', padding: '6px 10px'}
      : {width: inDialog ? 'auto' : 'min(360px,calc(100vw - 40px))', padding: '16px'});
  }
  function placePanel(dialog) {
    const host = dialog || document.body;
    if (panel.parentNode === host) return;
    host.append(panel);
    panel.removeAttribute('aria-hidden');
    panel.removeAttribute('inert');
    Object.assign(panel.style, dialog
      ? {position: 'relative', right: 'auto', bottom: 'auto', margin: '8px', maxHeight: '38vh', overflow: 'auto', flexShrink: '0'}
      : {position: 'fixed', right: '20px', bottom: '24px', margin: '0', maxHeight: '90vh', overflow: 'auto'});
    applyPanelSkin();
  }
  function render() {
    targetInput.disabled = startButton.disabled = run.running;
    startAtInput.disabled = stopAtInput.disabled = run.running;
    stopButton.disabled = !run.running;
    const total = run.targets.length;
    const readyCount = run.targets.filter(t => t.ready).length;
    statusLabel.textContent = `${liveStatus}\n最近检查：${checkedAt ? new Date(checkedAt).toLocaleTimeString() : '尚未检查'}`;
    // 最小化时仅剩状态点：绿=全部可连接，蓝=监守中，橙=关机流程，灰=空闲。
    dot.style.background = run.stopping ? '#d97706' : run.running ? (total > 0 && readyCount === total ? '#16a34a' : '#2563eb') : '#94a3b8';
    dot.title = run.running ? `目标 ${total} 个，可连接 ${readyCount} 个` : '未在监守';
    targetListData.textContent = '';
    for (const item of snapshotTargets) {
      const line = document.createElement('div');
      const text = document.createElement('span');
      text.textContent = item.line;
      line.append(text);
      // 可连接的目标提供快捷入口：等价于点“连接”后在官方弹窗里选 Web 或 VSCode。
      if (item.ready) {
        for (const [label, method] of [['Web', 'web'], ['VSCode', 'vscode']]) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.dataset.conn = method;
          b.dataset.target = item.name;
          line.append(b);
        }
      }
      targetListData.append(line);
    }
    targetListData.style.display = snapshotTargets.length ? '' : 'none';
    panel.querySelector('pre').textContent = run.logs.join('\n') || '尚未开始；请在上方填写环境名称，多个环境用逗号分隔（留空时自动读取当前全部环境）。';
  }
  function save() {
    sessionStorage.setItem(KEY, JSON.stringify(run));
    render();
  }
  function log(message) {
    run.logs.push(`${new Date().toLocaleTimeString()} ${message}`);
    run.logs = run.logs.slice(-40);
    console.info('[CANNLab 自动启动]', message);
    save();
  }
  function stop(message) {
    run.running = false;
    run.stopping = false;
    run.startAt = run.stopAt = 0;
    clearTimeout(timer);
    liveStatus = message;
    log(message);
  }
  function startSilently() {
    audioReady = false;
    if (typeof GM_audio === 'undefined' || typeof GM_audio.setMute !== 'function'
      || typeof GM_notification !== 'function') {
      return stop('无法启用静音和系统通知，请更新 Tampermonkey 并允许新版脚本权限后重试');
    }
    const currentRun = run;
    // 使用浏览器标签页静音，覆盖网页的媒体、Web Audio 和提示音；停止后保持静音。
    GM_audio.setMute({isMuted: true}, error => {
      if (run !== currentRun || !run.running) return;
      if (error) return stop(`标签页静音失败：${error}`);
      audioReady = true;
      tick();
    });
  }
  function notifyConnection(ready, name, status) {
    const spec = run.targets.find(t => t.target === name)?.spec;
    const label = spec ? `${name}（${spec}）` : name;
    try {
      GM_notification({
        title: ready ? `CANNLab：${label} 连接成功` : `CANNLab：${label} 连接不可用`,
        text: `${ready ? '环境已运行，连接按钮可用' : `连接已不可用，当前状态：${status}`}\n${new Date().toLocaleString()}`,
        tag: `cannlab-connection-${name}`
      });
    } catch (error) {
      log(`系统通知发送失败：${error.message}`);
    }
  }
  // 在官方“连接方式”弹窗中找到对应选项；结构未知时退回按文本匹配（webIde 在前、vscode 在后）。
  function findConnectOption(method) {
    const visible = e => !!e && e.getClientRects().length > 0 && document.defaultView.getComputedStyle(e).visibility !== 'hidden';
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter(visible).filter(e => e.getAttribute('data-state') !== 'closed' && e.getAttribute('aria-hidden') !== 'true');
    for (const dialog of dialogs) {
      const items = [...dialog.querySelectorAll('.connection-method-modal__item')].filter(b => !b.disabled && visible(b));
      if (!items.length) continue;
      const text = b => b.textContent.toLowerCase();
      if (method === 'web') return items.find(b => /web\s*ide|webide/.test(text(b))) || items[0];
      return items.find(b => /vs\s*code|vscode/.test(text(b))) || items[items.length - 1];
    }
    return null;
  }
  function connectTarget(name, method) {
    const label = method === 'web' ? 'Web IDE' : 'VSCode';
    const view = readViews(document, [name]).views.get(name);
    if (!view || view.error) return log(`[${name}] 未找到环境，无法发起${label}连接`);
    if (!view.connect) return log(`[${name}] 当前不可连接，无法发起${label}连接`);
    const button = view.buttons.连接;
    if (!button) return log(`[${name}] 未找到连接按钮，无法发起${label}连接`);
    log(`[${name}] 发起${label}连接`);
    button.click();
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const option = findConnectOption(method);
      if (option) {
        clearInterval(timer);
        option.click();
        log(`[${name}] 已在连接方式弹窗中选择${label}`);
      } else if (Date.now() - startedAt > 15_000) {
        // 未出现弹窗：站点可能记住了默认方式并已直接连接。
        clearInterval(timer);
        log(`[${name}] 未出现连接方式弹窗；若未开始连接，请在页面上手动选择`);
      }
    }, 500);
  }
  function tick() {
    if (!run.running || !audioReady) return;
    try {
      if (!isEnvPage(location)) return stop('已离开环境页面');
      const now = Date.now();
      if (run.stopAt && now >= run.stopAt && !run.stopping) {
        run.stopping = true;
        for (const t of run.targets) { t.ready = false; t.nextActionAt = 0; }
        log('已到结束时间，停止启动重试，开始依次关闭全部目标环境');
      }
      if (!run.stopping && run.startAt && now < run.startAt) {
        liveStatus = `等待定时开始：${new Date(run.startAt).toLocaleString()}`;
        render();
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      const scan = readViews(document, run.targets.map(t => t.target));
      checkedAt = now;
      // 页面模态框会锁住背景；把控制面板放入当前弹窗，使停止按钮仍可操作。
      placePanel(scan.dialogElement);
      // 确认框归属：正文「环境名」唯一命中的目标；脚本在确认框打开时启动，或停止后重启时按属主接续。
      const ownerName = scan.dialogInfo?.body
        ? (run.targets.find(t => scan.dialogInfo.body.includes(`「${t.target}」`))?.target ?? null)
        : null;
      if (ownerName) {
        const t = run.targets.find(x => x.target === ownerName);
        const view = scan.views.get(ownerName);
        if (t && view && !t.pending && view.dialog) {
          const action = run.stopping ? (view.dialog.title === '启动实例' ? '启动' : '关机')
            : view.status === '已关机' ? '启动' : view.status === '异常' ? '关机' : null;
          if (action && view.dialog.title === `${action}实例` && view.dialog.body === `确认${action}实例「${t.target}」吗？`) {
            t.pending = {action, status: view.status, at: now, confirmed: !view.dialog.enabled, busy: !view.dialog.enabled};
            log(`[${t.target}] 接续目标环境的${action}确认框`);
          }
        }
      }
      for (const t of run.targets) {
        if (t.pending?.confirmed && scan.dialogInfo?.title === `${t.pending.action}实例`
          && scan.dialogInfo?.body === `确认${t.pending.action}实例「${t.target}」吗？` && !scan.dialogInfo.enabled && !t.pending.busy) {
          t.pending.busy = true;
          save();
        }
      }
      let acted = null, tookAction = false, reloadWait = null;
      for (const t of run.targets) {
        const view = scan.views.get(t.target) || {error: '等待扫描'};
        if (view.spec) t.spec = view.spec;
        // 刷新后的首次渲染可能尚未完成；只给予短暂加载宽限，不点击其他环境。
        if (view.error && now - loadedAt < 25_000) { delete view.error; view.loading = true; }
        // 其他环境的确认框打开时页面被锁；未持有的目标本轮只等待，不参与决策。
        const gated = !!scan.dialogInfo && ownerName !== null && ownerName !== t.target;
        const result = gated ? {blocked: true, wait: '等待其他环境的确认框处理完成'}
          : decide(view, Object.assign({}, t, {stopping: run.stopping}), now);
        if (result.done) {
          if (!t.done) { t.done = true; log(`[${t.target}] ${result.wait}；等待其余环境关机`); }
          continue;
        }
        if (result.reload && !reloadWait) reloadWait = `[${t.target}] ${result.wait}`;
        const connected = !view.error && !view.loading && view.status === '运行中' && view.connect;
        if (connected && !t.ready && !run.stopping) {
          t.ready = true;
          t.successAt = now;
          t.pending = null;
          log(`[${t.target}] 环境已可连接，继续监守`);
          notifyConnection(true, t.target, view.status);
        } else if (!connected && t.ready && view.status && !view.error && !view.loading) {
          t.ready = false;
          log(`[${t.target}] 环境不再满足可连接条件（${view.status}），继续恢复检查`);
          notifyConnection(false, t.target, view.status);
        }
        if (result.blocked && t.lastBlocked !== result.wait) {
          t.lastBlocked = result.wait;
          log(`[${t.target}] ${result.wait}`);
        } else if (!result.blocked && t.lastBlocked) {
          delete t.lastBlocked;
          log(`[${t.target}] 状态或弹窗已就绪，继续检查`);
        }
        if (view.status && view.status !== t.lastStatus) {
          t.lastStatus = view.status;
          // 保留最近一次启停记录：状态可能先更新，确认框随后才退出。
          log(`[${t.target}] 状态：${view.status}`);
        }
        if ((result.cancel || result.confirm || result.action) && tookAction) {
          // 本轮已有其他环境执行了动作；页面动作互斥，下一个轮询周期再处理该目标。
          continue;
        }
        if (result.cancel) {
          tookAction = true;
          acted = {target: t.target, text: '关闭确认框'};
          // 先把面板移回页面，防止跟着弹窗一起卸载。
          placePanel(null);
          view.buttons.cancel.click();
          if (!(run.stopping && t.pending?.confirmed && t.pending.action === '启动')) t.pending = null;
          t.nextActionAt = run.stopping ? 0 : now + RETRY_MS;
          log(`[${t.target}] ${result.wait}；${run.stopping ? '继续检查关机状态' : '60 秒后重试'}`);
        } else if (result.confirm) {
          tookAction = true;
          acted = {target: t.target, text: `确认${result.confirm}`};
          t.pending.confirmed = true;
          t.pending.busy = false;
          t.pending.at = now;
          log(`[${t.target}] 确认${result.confirm}`);
          view.buttons.confirm.click();
          // 同步变为禁用的按钮无需等下一次轮询；短暂请求也能记录到忙碌状态。
          t.pending.busy = view.buttons.confirm.disabled || view.buttons.confirm.getAttribute('aria-disabled') === 'true';
          save();
        } else if (result.action) {
          tookAction = true;
          acted = {target: t.target, text: `正在${result.action}`};
          t.pending = {action: result.action, status: view.status, at: now};
          t.nextActionAt = now + RETRY_MS;
          if (result.action === '启动') t.attempts += 1;
          log(`[${t.target}] 点击${result.action}；累计启动 ${t.attempts} 次`);
          // 使用刚刚定位的目标行按钮，不操作“删除”或其他环境。
          view.buttons[result.action].click();
        }
      }
      if (run.stopping && run.targets.length && run.targets.every(t => t.done)) {
        return stop('定时任务完成：全部目标环境已关机');
      }
      const readyCount = run.targets.filter(t => t.ready).length;
      liveStatus = acted ? `[${acted.target}] ${acted.text}`
        : run.stopping ? `定时关机中：已关机 ${run.targets.filter(t => t.done).length}/${run.targets.length}`
        : `监守中：可连接 ${readyCount}/${run.targets.length}`;
      render();
      if (reloadWait) {
        log(reloadWait);
        location.reload();
        return;
      }
      // ponytail: 只在一个标签页运行；sessionStorage 保留刷新前的截止时间和点击间隔。
      if (!tookAction && !scan.dialogInfo && now - loadedAt >= 60_000) {
        save();
        location.reload();
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    } catch (error) {
      run.running = false;
      clearTimeout(timer);
      run.logs.push(`脚本停止：${error.message}`);
      try { sessionStorage.removeItem(KEY); } catch { /* 存储不可用时保持停止。 */ }
      render();
      console.error('[CANNLab 自动启动]', error);
    }
  }
  panel.querySelector('[data-action="inspect"]').onclick = () => {
    refreshStatus();
    const names = run.running ? run.targets.map(t => t.target) : parseTargets(targetInput.value);
    if (!names.length) { liveStatus = '请先填写目标环境名称'; render(); return; }
    const scan = readViews(document, names);
    liveStatus = names.map(n => {
      const v = scan.views.get(n);
      if (!v) return `${n}：等待扫描`;
      if (v.error) return `${n}：${v.error}`;
      const spec = v.spec ? `（${v.spec}）` : '';
      return `${n}${spec}：${v.status || '（空）'}；连接${v.connect ? '可用' : '不可用'}`;
    }).join('\n') + (scan.dialogInfo ? `\n弹窗：${scan.dialogInfo.title || scan.dialogInfo.text}` : '');
    log(liveStatus.replace(/\n/g, ' ／ '));
  };
  startButton.onclick = () => {
    const names = parseTargets(targetInput.value);
    if (!names.length) return log('请填写至少一个环境名称；多个环境用逗号分隔，留空可自动读取当前全部环境');
    const now = Date.now();
    const startAt = startAtInput.value ? new Date(startAtInput.value).getTime() : 0;
    const stopAt = stopAtInput.value ? new Date(stopAtInput.value).getTime() : 0;
    if (!Number.isFinite(startAt) || !Number.isFinite(stopAt)) return log('请输入有效的开始和结束时间');
    if (startAt && startAt <= now) return log('开始时间必须晚于当前时间；立即开始请留空');
    if (stopAt && stopAt <= Math.max(now, startAt)) return log('结束时间必须晚于开始时间和当前时间');
    const previous = new Map((run.targets || []).map(t => [t.target, t]));
    run = {running: true, startAt, stopAt, stopping: false,
      targets: names.map(name => ({target: name, pending: null, nextActionAt: 0, ready: false,
        successAt: previous.get(name)?.successAt ?? null, attempts: 0})),
      minimized: run.minimized === true, logs: []};
    clearTimeout(timer);
    try { log(`${startAt ? '已保存定时计划' : '开始持续监守'}：${names.join('、')}；${stopAt ? `结束并关机：${new Date(stopAt).toLocaleString()}` : '不限时'}`); startSilently(); }
    catch (error) { run.running = false; render(); panel.querySelector('pre').textContent = `无法保存运行状态：${error.message}`; }
  };
  stopButton.onclick = () => stop('已手动停止；服务器保持当前状态');
  targetListData.addEventListener('click', e => {
    const b = e.target.closest('button[data-conn]');
    if (!b) return;
    connectTarget(b.dataset.target, b.dataset.conn);
  });
  minimizeButton.onclick = () => {
    minimized = !minimized;
    run.minimized = minimized;
    applyPanelSkin();
    save();
  };
  // 回到标签页或浏览器窗口时立即复查，不等后台延迟的旧定时器。
  function wake() {
    if (!run.running || !audioReady) return;
    clearTimeout(timer);
    timer = setTimeout(tick, 0);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  document.defaultView.addEventListener('focus', wake);
  // 即使手动停止，弹窗卸载后也要把面板移回页面。
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => placePanel(findDialogElement(document)))
      .observe(document.body, {childList: true, subtree: true});
  }
  // 状态栏独立只读刷新，等待定时和手动停止期间也能看到服务器的最新状态。
  applyPanelSkin();
  refreshStatus();
  setInterval(refreshStatus, POLL_MS);
  if (run.running) startSilently();
})();