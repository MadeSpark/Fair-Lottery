(function () {
  'use strict';

  const API_BASE = '/api';
  const FP_CACHE_KEY = 'fair-lottery-device-fp-v1';
  const JOINED_KEY = 'fair-lottery-joined-v1';

  // ---------- Tab 切换 ----------
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      tabPanels.forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  function switchTo(tabName) {
    tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
    tabPanels.forEach((p) => p.classList.toggle('active', p.id === `tab-${tabName}`));
  }

  // ---------- 通用请求封装 ----------
  async function api(path, options) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const json = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
    if (!res.ok || !json.ok) {
      const err = new Error(json.error || `请求失败 (HTTP ${res.status})`);
      err.code = json.code || '';
      throw err;
    }
    return json.data;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  function showBox(el, html) {
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  function errorHtml(message) {
    return `<p class="error-text">出错了：${escapeHtml(message)}</p>`;
  }

  function toLocalDateTimeValue(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // ---------- API 文档与示例代码生成 ----------
  const apiEndpoints = [
    { id: 'create', method: 'POST', path: '/api/lotteries', name: '创建抽奖', description: '创建活动并锁定中奖人数、报名截止时间和密钥承诺。' },
    { id: 'list', method: 'POST', path: '/api/lotteries/list', name: '获取活动列表', description: '返回所有活动的公开摘要。' },
    { id: 'detail', method: 'POST', path: '/api/lotteries/:id', name: '获取活动详情', description: '返回活动公开数据，可用于独立验证。' },
    { id: 'join', method: 'POST', path: '/api/lotteries/:id/participants', name: '参与抽奖', description: '提交唯一编号和浏览器设备指纹。' },
    { id: 'draw', method: 'POST', path: '/api/lotteries/:id/draw', name: '开奖 / 追加抽取', description: '报名截止后开奖；已开奖活动可传更大的额外人数追加名额。' },
  ];
  let activeApiEndpoint = 'create';
  let activeApiLanguage = 'curl';

  function apiBaseUrl() {
    return window.location.origin;
  }

  function apiField(label, key, value, wide) {
    return `<label class="api-field${wide ? ' api-field-wide' : ''}">${escapeHtml(label)}<input data-api-param="${key}" value="${escapeHtml(value)}" /></label>`;
  }

  function apiParameters(endpointId) {
    const defaults = {
      title: '春节福利抽奖',
      winnerCount: '3',
      closeAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      useExternalRandomness: 'true',
      id: '活动ID',
      code: 'USER-0001',
      fingerprint: '浏览器生成的设备指纹',
      extraDrawCount: '0',
    };
    if (endpointId === 'create') {
      return [apiField('活动标题 title', 'title', defaults.title), apiField('中奖人数 winnerCount', 'winnerCount', defaults.winnerCount), apiField('截止时间 closeAt (ISO 8601)', 'closeAt', defaults.closeAt, true), apiField('启用 drand useExternalRandomness', 'useExternalRandomness', defaults.useExternalRandomness, true)].join('');
    }
    if (endpointId === 'detail' || endpointId === 'join' || endpointId === 'draw') {
      const fields = [apiField('活动 ID', 'id', defaults.id, endpointId !== 'join')];
      if (endpointId === 'join') fields.push(apiField('参与编号 code', 'code', defaults.code), apiField('设备指纹 fingerprint', 'fingerprint', defaults.fingerprint, true));
      if (endpointId === 'draw') fields.push(apiField('额外抽取人数 extraDrawCount', 'extraDrawCount', defaults.extraDrawCount));
      return fields.join('');
    }
    return '<p class="hint">此接口没有请求参数。</p>';
  }

  function readApiParameters() {
    const values = {};
    document.querySelectorAll('[data-api-param]').forEach((input) => {
      values[input.dataset.apiParam] = input.value;
    });
    return values;
  }

  function apiRequestDefinition() {
    const endpoint = apiEndpoints.find((item) => item.id === activeApiEndpoint);
    const p = readApiParameters();
    let path = endpoint.path.replace(':id', encodeURIComponent(p.id || '活动ID'));
    let body = null;
    if (endpoint.id === 'create') {
      body = { title: p.title || '', winnerCount: Number(p.winnerCount || 0), closeAt: p.closeAt || '', useExternalRandomness: p.useExternalRandomness !== 'false' };
    } else if (endpoint.id === 'join') {
      body = { code: p.code || '', fingerprint: p.fingerprint || '' };
    } else if (endpoint.id === 'draw') {
      body = { extraDrawCount: Number(p.extraDrawCount || 0) };
    }
    return { endpoint, url: `${apiBaseUrl()}${path}`, body };
  }

  function shellQuote(value) {
    return String(value).replace(/'/g, "'\\\"'\\\"'");
  }

  function generateApiCode(language) {
    const { endpoint, url, body } = apiRequestDefinition();
    if (language === 'curl') {
      const base = `curl --request ${endpoint.method} '${shellQuote(url)}'`;
      if (!body) return base;
      return `${base} \\\n+  --header 'Content-Type: application/json' \\\n+  --data '${shellQuote(JSON.stringify(body))}'`;
    }
    if (language === 'php') {
      const options = body
        ? `CURLOPT_HTTPHEADER => ['Content-Type: application/json'],\n  CURLOPT_POSTFIELDS => ${JSON.stringify(JSON.stringify(body))},\n  CURLOPT_CUSTOMREQUEST => '${endpoint.method}',`
        : `CURLOPT_CUSTOMREQUEST => '${endpoint.method}',`;
      return `<?php\n$url = '${url.replace(/'/g, "\\'")}';\n$ch = curl_init($url);\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  ${options}\n]);\n$response = curl_exec($ch);\n$statusCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);\nif ($response === false) {\n  throw new RuntimeException(curl_error($ch));\n}\ncurl_close($ch);\n$data = json_decode($response, true);\nprint_r($data);\n`;
    }
    const payload = body ? `\nimport json\npayload = json.loads(${JSON.stringify(JSON.stringify(body))})\n` : '';
    const requestArgs = body ? ', json=payload' : '';
    return `import requests\n\nurl = "${url}"${payload}\nresponse = requests.${endpoint.method.toLowerCase()}(url${requestArgs}, timeout=15)\nresponse.raise_for_status()\nresult = response.json()\nprint(result)\n`;
  }

  function renderApiDocs() {
    const endpoint = apiEndpoints.find((item) => item.id === activeApiEndpoint);
    const catalog = document.getElementById('api-catalog');
    const meta = document.getElementById('api-meta');
    const parameters = document.getElementById('api-parameters');
    if (!catalog || !meta || !parameters) return;
    catalog.innerHTML = apiEndpoints
      .map((item) => `<button class="api-endpoint-btn${item.id === activeApiEndpoint ? ' active' : ''}" data-api-endpoint="${item.id}"><span class="api-method">${item.method}</span>${escapeHtml(item.path)}<span class="api-endpoint-name">${escapeHtml(item.name)}</span></button>`)
      .join('');
    meta.innerHTML = `<h3>${escapeHtml(endpoint.name)}</h3><p>${escapeHtml(endpoint.description)}</p><span class="api-path"><strong>${endpoint.method}</strong> ${escapeHtml(endpoint.path)}</span>`;
    parameters.innerHTML = apiParameters(endpoint.id);
    renderApiCode();

    catalog.querySelectorAll('[data-api-endpoint]').forEach((button) => {
      button.addEventListener('click', () => {
        activeApiEndpoint = button.dataset.apiEndpoint;
        renderApiDocs();
      });
    });
    parameters.querySelectorAll('[data-api-param]').forEach((input) => input.addEventListener('input', renderApiCode));
  }

  function renderApiCode() {
    const output = document.getElementById('api-code-output');
    const label = document.getElementById('api-code-label');
    if (!output || !label) return;
    output.textContent = generateApiCode(activeApiLanguage).replace(/\n\+/g, '\n');
    label.textContent = `${activeApiLanguage === 'curl' ? '终端命令' : activeApiLanguage === 'php' ? 'PHP cURL' : 'Python requests'} 示例`;
  }

  function shortHash(hash) {
    if (!hash) return '';
    return hash.length > 16 ? `${hash.slice(0, 16)}...` : hash;
  }

  // ---------- 参与链接与复制 ----------
  function joinLinkFor(id) {
    const url = new URL(window.location.href);
    url.hash = '';
    url.search = '';
    url.searchParams.set('join', id);
    return url.toString();
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => copyTextFallback(text)
      );
    }
    return Promise.resolve(copyTextFallback(text));
  }

  function copyTextFallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const done = document.execCommand('copy');
      document.body.removeChild(ta);
      return done;
    } catch (e) {
      return false;
    }
  }

  /**
   * 统一绑定「复制」按钮：按钮放在 .copy-row 里，同行的 .link-input 就是
   * 要复制的内容。点击后短暂把按钮文字改成反馈，再恢复。
   */
  function bindCopyButtons(root) {
    root.querySelectorAll('button[data-copy-input]').forEach((btn) => {
      if (btn.dataset.copyBound) return;
      btn.dataset.copyBound = '1';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const row = btn.closest('.copy-row');
        const input = row ? row.querySelector('.link-input') : null;
        const text = input ? input.value : '';
        if (!text) return;
        const done = await copyText(text);
        if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
        btn.textContent = done ? '已复制 ✓' : '复制失败，请手动选中';
        if (input && input.select) input.select();
        setTimeout(() => {
          btn.textContent = btn.dataset.label || '复制参与链接';
        }, 1600);
      });
    });
  }

  // ================= 设备指纹 =================
  // 目标：在同一台设备 + 同一个浏览器上稳定得到同一个值，用来实现
  // 「一个设备在同一活动中只能参与一次」。采集的都是浏览器公开的
  // 渲染特征，不涉及任何个人身份信息，且只以哈希形式上报。

  let fingerprintPromise = null;

  function getDeviceFingerprint() {
    if (!fingerprintPromise) {
      fingerprintPromise = computeFingerprint().catch(() => '');
    }
    return fingerprintPromise;
  }

  async function computeFingerprint() {
    try {
      const cached = localStorage.getItem(FP_CACHE_KEY);
      if (cached && /^[0-9a-f]{32,128}$/.test(cached)) return cached;
    } catch (e) {
      /* 隐私模式下可能不可用，忽略 */
    }

    const parts = [
      'ua:' + navigator.userAgent,
      'uaCh:' + (navigator.userAgentData && navigator.userAgentData.platform ? navigator.userAgentData.platform : ''),
      'lang:' + (navigator.language || ''),
      'langs:' + ((navigator.languages || []).join(',') || ''),
      'platform:' + (navigator.platform || ''),
      'cores:' + (navigator.hardwareConcurrency || 0),
      'mem:' + (navigator.deviceMemory || 0),
      'touch:' + (navigator.maxTouchPoints || 0),
      'tz:' + getTimeZone(),
      'tzoff:' + new Date().getTimezoneOffset(),
      'screen:' + [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth].join('x'),
      'dpr:' + (window.devicePixelRatio || 1),
      'canvas:' + canvasFingerprint(),
      'webgl:' + webglFingerprint(),
      'fonts:' + fontFingerprint(),
      'audio:' + audioFingerprint(),
    ];

    const hash = await sha256Hex(parts.join('|'));
    try {
      localStorage.setItem(FP_CACHE_KEY, hash);
    } catch (e) {
      /* 忽略 */
    }
    return hash;
  }

  function getTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      return '';
    }
  }

  function canvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 260;
      canvas.height = 70;
      const ctx = canvas.getContext('2d');
      if (!ctx) return 'no-2d';
      ctx.textBaseline = 'top';
      ctx.font = '16px "Arial"';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 120, 30);
      ctx.fillStyle = '#069';
      ctx.fillText('公平抽奖 fair-lottery 0123', 2, 2);
      ctx.fillStyle = 'rgba(102,204,0,0.75)';
      ctx.fillText('设备特征 mmmmllll', 4, 22);
      ctx.globalCompositeOperation = 'multiply';
      ctx.beginPath();
      ctx.arc(60, 34, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255,0,120,0.6)';
      ctx.font = 'italic 15px "Times New Roman"';
      ctx.strokeText('渲染差异 中文测试', 12, 44);
      return canvas.toDataURL();
    } catch (e) {
      return 'canvas-error';
    }
  }

  function webglFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return 'no-webgl';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return [
        vendor,
        renderer,
        gl.getParameter(gl.VERSION),
        gl.getParameter(gl.MAX_TEXTURE_SIZE),
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
        (gl.getSupportedExtensions() || []).length,
      ].join('~');
    } catch (e) {
      return 'webgl-error';
    }
  }

  function fontFingerprint() {
    try {
      const baseFonts = ['monospace', 'sans-serif', 'serif'];
      const testFonts = ['Arial', 'Microsoft YaHei', 'PingFang SC', 'SimSun', 'Segoe UI', 'Tahoma', 'Courier New'];
      const testText = 'mmmmmmmmmmlli公平抽奖W1234567890';
      const span = document.createElement('span');
      span.style.cssText =
        'position:absolute;left:-9999px;top:-9999px;font-size:72px;white-space:nowrap;visibility:hidden;';
      span.textContent = testText;
      document.body.appendChild(span);
      const out = [];
      for (const f of testFonts) {
        for (const base of baseFonts) {
          span.style.fontFamily = `'${f}',${base}`;
          out.push(`${f}/${base}:${span.offsetWidth}x${span.offsetHeight}`);
        }
      }
      document.body.removeChild(span);
      return out.join(',');
    } catch (e) {
      return 'font-error';
    }
  }

  /** 音频栈差异：不同设备/驱动的浮点结果会有细微不同 */
  function audioFingerprint() {
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Ctx) return 'no-audio';
      const ctx = new Ctx(1, 44100, 44100);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      const comp = ctx.createDynamicsCompressor();
      osc.connect(comp);
      comp.connect(ctx.destination);
      osc.start(0);
      // 不等待渲染完成，只取可同步拿到的上限值做特征，避免阻塞提交
      return `${ctx.sampleRate}|${ctx.length}|${comp.reduction || 0}`;
    } catch (e) {
      return 'audio-error';
    }
  }

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    if (window.crypto && window.crypto.subtle) {
      try {
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      } catch (e) {
        /* 例如非安全上下文，退回到纯 JS 实现 */
      }
    }
    return fallbackHash(text);
  }

  /** 无 WebCrypto 时的确定性兜底哈希（输出 64 位十六进制，格式与 SHA256 一致） */
  function fallbackHash(text) {
    const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0x2545f491];
    return seeds
      .map((seed) => {
        let h = seed >>> 0;
        for (let i = 0; i < text.length; i++) {
          h ^= text.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
      })
      .join('');
  }

  /** 本机已参与过的活动（仅本地记录，用于体验提示，最终以服务端判定为准） */
  function joinedLocally(id) {
    try {
      return (JSON.parse(localStorage.getItem(JOINED_KEY) || '[]') || []).indexOf(id) !== -1;
    } catch (e) {
      return false;
    }
  }

  function markJoinedLocally(id) {
    try {
      const list = JSON.parse(localStorage.getItem(JOINED_KEY) || '[]') || [];
      if (list.indexOf(id) === -1) list.push(id);
      localStorage.setItem(JOINED_KEY, JSON.stringify(list.slice(-200)));
    } catch (e) {
      /* 忽略 */
    }
  }

  // ---------- 创建抽奖 ----------
  const formCreate = document.getElementById('form-create');
  const createResult = document.getElementById('create-result');
  const closeAtInputElement = document.getElementById('create-close-at');
  const minimumCloseAt = new Date(Date.now() + 60 * 1000);
  closeAtInputElement.min = toLocalDateTimeValue(minimumCloseAt);
  closeAtInputElement.value = toLocalDateTimeValue(new Date(Date.now() + 10 * 60 * 1000));

  formCreate.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('create-title').value.trim();
    const winnerCount = Number(document.getElementById('create-winner-count').value);
    const closeAtInput = document.getElementById('create-close-at').value;
    const useExternalRandomness = document.getElementById('create-external').checked;
    const closeAt = closeAtInput ? new Date(closeAtInput).toISOString() : '';

    showBox(createResult, '正在创建...');
    try {
      const lottery = await api('/lotteries', {
        method: 'POST',
        body: JSON.stringify({ title, winnerCount, closeAt, useExternalRandomness }),
      });
      const joinLink = joinLinkFor(lottery.id);
      showBox(
        createResult,
        `
        <p>抽奖创建成功！把下面的<strong>参与链接</strong>发给参与者，他们点开就能直接进入参与页面。</p>
        <div class="copy-row">
          <input type="text" class="link-input" id="create-join-link" readonly value="${escapeHtml(joinLink)}" />
          <button class="btn" data-copy-input="1">复制参与链接</button>
        </div>
        <dl class="kv">
          <dt>活动 ID</dt><dd>${escapeHtml(lottery.id)}</dd>
          <dt>标题</dt><dd>${escapeHtml(lottery.title)}</dd>
          <dt>中奖人数</dt><dd>${lottery.winnerCount}</dd>
          <dt>报名截止</dt><dd>${escapeHtml(lottery.closeAt)}</dd>
          <dt>密钥承诺</dt><dd>${escapeHtml(lottery.commitHash)}</dd>
          <dt>创建时间</dt><dd>${escapeHtml(lottery.createdAt)}</dd>
        </dl>
        <p class="hint">密钥承诺（commitHash）已经在此刻公开锁定，开奖时会揭示真实密钥，任何人都能验证两者是否吻合。报名截止前不能开奖，截止时间后也不能再加入。</p>
        <p class="hint">同一台设备在本场活动中只能参与一次，可以放心把链接发到群里。</p>
        <div class="btn-row">
          <button class="btn btn-secondary" data-goto-join="${escapeHtml(lottery.id)}">去参与这场抽奖</button>
          <button class="btn btn-secondary" data-goto-view="${escapeHtml(lottery.id)}">查看/开奖</button>
        </div>
        `
      );
      bindCopyButtons(createResult);
    } catch (err) {
      showBox(createResult, errorHtml(err.message));
    }
  });

  // ---------- 参与抽奖 ----------
  const formJoin = document.getElementById('form-join');
  const joinResult = document.getElementById('join-result');
  const joinBanner = document.getElementById('join-banner');
  const deviceHint = document.getElementById('device-hint');

  // 进入页面就先把指纹算好，避免用户点提交时才发现异常
  getDeviceFingerprint().then((fp) => {
    if (fp) {
      deviceHint.textContent = `本机设备标识：${shortHash(fp)}（仅用于判定同一设备只参与一次）`;
    } else {
      deviceHint.textContent = '未能读取设备标识，提交时可能被服务器拒绝。';
      deviceHint.classList.add('error-text');
    }
  });

  formJoin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('join-id').value.trim();
    const code = document.getElementById('join-code').value.trim();

    showBox(joinResult, '正在提交...');
    try {
      const fingerprint = await getDeviceFingerprint();
      const entry = await api(`/lotteries/${encodeURIComponent(id)}/participants`, {
        method: 'POST',
        body: JSON.stringify({ code, fingerprint }),
      });
      markJoinedLocally(id);
      showBox(
        joinResult,
        `
        <p>参与成功！请保存好你的<strong>收据哈希</strong>，之后可以用它核实你的记录没有被篡改。</p>
        <dl class="kv">
          <dt>你的编号</dt><dd>${escapeHtml(entry.code)}</dd>
          <dt>加入顺序</dt><dd>第 ${entry.index + 1} 位</dd>
          <dt>加入时间</dt><dd>${escapeHtml(entry.joinedAt)}</dd>
          <dt>收据哈希</dt><dd>${escapeHtml(entry.receipt)}</dd>
        </dl>
        <p class="hint">本机设备标识已登记，本场活动内这台设备不能再提交第二次。</p>
        `
      );
    } catch (err) {
      let extra = '';
      if (err.code === 'DEVICE_ALREADY_JOINED') {
        extra = '<p class="hint">换一个浏览器或换一台设备也无法重复参与同一场活动，这是公平性设计的一部分。</p>';
      }
      showBox(joinResult, errorHtml(err.message) + extra);
    }
  });

  // ---------- 查看 / 开奖 ----------
  const formView = document.getElementById('form-view');
  const viewResult = document.getElementById('view-result');

  formView.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('view-id').value.trim();
    await loadAndRenderLottery(id);
  });

  async function loadAndRenderLottery(id) {
    showBox(viewResult, '正在查询...');
    try {
      const lottery = await api(`/lotteries/${encodeURIComponent(id)}`, { method: 'POST' });
      renderLotteryDetail(lottery);
    } catch (err) {
      showBox(viewResult, errorHtml(err.message));
    }
  }

  function statusBadgeHtml(status) {
    if (status === 'drawn') return '<span class="badge badge-drawn">已开奖</span>';
    if (status === 'closed') return '<span class="badge badge-closed">报名已截止</span>';
    return '<span class="badge badge-pending">进行中</span>';
  }

  function participantListHtml(lottery) {
    return lottery.participants
      .map((p) => {
        const device = p.deviceHash
          ? `<span class="device-tag" title="${escapeHtml(p.deviceHash)}">设备 ${escapeHtml(shortHash(p.deviceHash))}</span>`
          : '<span class="device-tag device-tag-legacy">历史记录（无设备标识）</span>';
        return `<li>#${p.index + 1} - ${escapeHtml(p.code)} <span class="muted">${escapeHtml(p.joinedAt)}</span> ${device}</li>`;
      })
      .join('');
  }

  /** 读取「额外抽取人数」输入框当前值 */
  function readExtraDrawCount() {
    const el = document.getElementById('view-extra-count');
    if (!el) return 0;
    const v = Math.floor(Number(el.value));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function renderLotteryDetail(lottery) {
    const drawnExtra = lottery.extraDrawCount || 0;
    const extraWinners = lottery.extraWinners || [];
    const joinLink = joinLinkFor(lottery.id);
    const requestedExtra = readExtraDrawCount();

    let winnersHtml = '';
    let drawBtnHtml = '';

    if (lottery.status === 'drawn') {
      const winnerItems = (lottery.winners || []).map((w) => `<li>${escapeHtml(w)}</li>`).join('');
      winnersHtml = `
        <h3>中奖名单（${(lottery.winners || []).length} 人）</h3>
        <ol class="winner-list">${winnerItems}</ol>
        <dl class="kv">
          <dt>开奖时间</dt><dd>${escapeHtml(lottery.drawnAt)}</dd>
          <dt>揭示密钥</dt><dd>${escapeHtml(lottery.secret)}</dd>
          <dt>最终种子</dt><dd>${escapeHtml(lottery.finalSeed)}</dd>
        </dl>
      `;

      if (drawnExtra > 0) {
        const extraItems = extraWinners.length
          ? extraWinners.map((w) => `<li>${escapeHtml(w)}</li>`).join('')
          : '<li class="muted">参与者人数不足，没有抽到额外名额</li>';
        winnersHtml += `
          <h3>额外中奖名单（${extraWinners.length} / ${drawnExtra} 人）</h3>
          <p class="hint">这是在中奖名单之后<strong>追加</strong>抽取的，只是追加，与上面的中奖名单互不影响，两边的人也不会重复。</p>
          <ol class="winner-list extra-winner-list">${extraItems}</ol>
        `;
      }

      if (lottery.externalRandomness) {
        const ext = lottery.externalRandomness;
        winnersHtml += `
          <h4>外部公开随机数信标 (drand)</h4>
          <dl class="kv">
            <dt>状态</dt><dd>${escapeHtml(ext.status)}</dd>
            ${ext.status === 'fetched' ? `<dt>轮次</dt><dd>${ext.targetRound}</dd><dt>随机值</dt><dd>${escapeHtml(ext.value)}</dd>` : `<dt>说明</dt><dd>${escapeHtml(ext.error || '')}</dd>`}
          </dl>
        `;
      }

      // 已开奖：仍可在原有中奖名单之外继续追加额外抽取
      drawBtnHtml = `
        <div class="append-row">
          <button class="btn" id="btn-draw">追加抽取</button>
          <span class="hint" id="append-hint"></span>
        </div>
      `;
    } else if (lottery.status === 'closed') {
      drawBtnHtml = `
        <p class="hint">将额外抽取 <strong>${requestedExtra}</strong> 人（可在上方修改「额外抽取人数」）。额外抽取只是在原有中奖名单之后追加，不会改变原名单。</p>
        <button class="btn" id="btn-draw">立即开奖</button>
      `;
    } else {
      drawBtnHtml = `<p class="hint">报名进行中，截止时间后才能开奖：${escapeHtml(lottery.closeAt)}</p>`;
    }

    showBox(
      viewResult,
      `
      <div class="kv">
        <dt>标题</dt><dd>${escapeHtml(lottery.title)} ${statusBadgeHtml(lottery.status)}</dd>
        <dt>活动 ID</dt><dd>${escapeHtml(lottery.id)}</dd>
        <dt>中奖人数</dt><dd>${lottery.winnerCount}</dd>
        <dt>额外抽取</dt><dd>${drawnExtra} 人</dd>
        <dt>参与人数</dt><dd>${lottery.participants.length}</dd>
        <dt>报名截止</dt><dd>${escapeHtml(lottery.closeAt)}</dd>
        <dt>密钥承诺</dt><dd>${escapeHtml(lottery.commitHash)}</dd>
        <dt>当前链头</dt><dd>${escapeHtml(lottery.chainHead)}</dd>
      </div>
      <div class="copy-row">
        <input type="text" class="link-input" readonly value="${escapeHtml(joinLink)}" />
        <button class="btn btn-secondary" data-copy-input="1">复制参与链接</button>
      </div>
      ${drawBtnHtml}
      ${winnersHtml}
      <details style="margin-top:16px">
        <summary>查看全部参与者（${lottery.participants.length} 人）</summary>
        <ul class="participant-list">${participantListHtml(lottery)}</ul>
      </details>
      <div class="btn-row">
        <button class="btn btn-secondary" id="btn-download">下载完整验证数据 (JSON)</button>
        <button class="btn btn-secondary" id="btn-refresh-detail">刷新</button>
      </div>
      <p class="hint">下载数据后，在终端运行 <code>node scripts/verify.js 文件名.json</code> 即可本地独立验证开奖结果与额外中奖名单。</p>
      `
    );

    bindCopyButtons(viewResult);

    const drawBtn = document.getElementById('btn-draw');
    if (drawBtn) {
      const isAppend = lottery.status === 'drawn';

      // 已开奖时按钮退化为「追加抽取」：只有输入的人数大于已抽人数才可用
      if (isAppend) {
        const extraInput = document.getElementById('view-extra-count');
        const appendHint = document.getElementById('append-hint');
        const syncAppendButton = () => {
          const want = readExtraDrawCount();
          const delta = want - drawnExtra;
          if (delta > 0) {
            drawBtn.disabled = false;
            drawBtn.textContent = `追加抽取 ${delta} 人（共 ${want} 人）`;
            if (appendHint) appendHint.textContent = '原有中奖名单不会改变，只是在后面追加。';
          } else {
            drawBtn.disabled = true;
            drawBtn.textContent = '追加抽取';
            if (appendHint) {
              appendHint.textContent = `当前已额外抽取 ${drawnExtra} 人。把上方「额外抽取人数」改大即可继续追加，只能调大不能调小。`;
            }
          }
        };
        if (extraInput) extraInput.addEventListener('input', syncAppendButton);
        syncAppendButton();
      }

      drawBtn.addEventListener('click', async () => {
        const extra = readExtraDrawCount();
        drawBtn.disabled = true;
        drawBtn.textContent = isAppend ? '追加中...' : '开奖中...';
        try {
          const updated = await api(`/lotteries/${encodeURIComponent(lottery.id)}/draw`, {
            method: 'POST',
            body: JSON.stringify({ extraDrawCount: extra }),
          });
          renderLotteryDetail(updated);
        } catch (err) {
          showBox(viewResult, errorHtml(err.message));
        }
      });
    }

    document.getElementById('btn-download').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(lottery, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lottery-${lottery.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('btn-refresh-detail').addEventListener('click', () => {
      loadAndRenderLottery(lottery.id);
    });
  }

  // ---------- 跳转按钮 ----------
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.getAttribute) return;
    const gotoJoinId = target.getAttribute('data-goto-join');
    const gotoViewId = target.getAttribute('data-goto-view');
    if (gotoJoinId) {
      switchTo('join');
      document.getElementById('join-id').value = gotoJoinId;
      loadJoinBanner(gotoJoinId);
    } else if (gotoViewId) {
      switchTo('view');
      document.getElementById('view-id').value = gotoViewId;
      loadAndRenderLottery(gotoViewId);
    }
  });

  // ---------- 全部活动列表 ----------
  const listResult = document.getElementById('list-result');
  const btnRefreshList = document.getElementById('btn-refresh-list');

  async function loadList() {
    listResult.innerHTML = '加载中...';
    try {
      const items = await api('/lotteries/list', { method: 'POST' });
      if (items.length === 0) {
        listResult.innerHTML = '<p class="hint">还没有任何抽奖活动。</p>';
        return;
      }
      listResult.innerHTML = items
        .map((item) => {
          const link = joinLinkFor(item.id);
          return `
        <div class="lottery-card" data-id="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.title)}</strong>
           ${statusBadgeHtml(item.status)}
          <div class="card-meta">
            ID: ${escapeHtml(item.id)} | 参与人数: ${item.participantCount} | 中奖: ${item.winnerCount}${item.extraDrawCount ? ` + 额外 ${item.extraDrawCount}` : ''} | 截止于 ${escapeHtml(item.closeAt)}
          </div>
          <div class="copy-row card-copy-row">
            <input type="text" class="link-input" readonly value="${escapeHtml(link)}" />
            <button class="btn btn-secondary btn-sm" data-copy-input="1">复制参与链接</button>
          </div>
        </div>
      `;
        })
        .join('');
      bindCopyButtons(listResult);
    } catch (err) {
      listResult.innerHTML = errorHtml(err.message);
    }
  }

  btnRefreshList.addEventListener('click', loadList);

  listResult.addEventListener('click', (e) => {
    const card = e.target.closest('.lottery-card');
    if (card) {
      const id = card.getAttribute('data-id');
      switchTo('view');
      document.getElementById('view-id').value = id;
      loadAndRenderLottery(id);
    }
  });

  // ---------- 通过参与链接进入时自动填好活动 ID ----------
  function loadJoinBanner(id) {
    const url = new URL(window.location.href);
    url.hash = '';
    url.search = '';
    url.searchParams.set('join', id);
    if (history.replaceState) {
      history.replaceState(null, '', url.toString());
    }
    joinBanner.classList.remove('hidden');
    joinBanner.classList.remove('banner-error');
    joinBanner.innerHTML = `已为你自动填入活动 ID：<code>${escapeHtml(id)}</code>。只需填写你的参与编号即可参加。${joinedLocally(id) ? '（注意：本机记录显示你已经参加过这场活动了）' : ''}`;

    api(`/lotteries/${encodeURIComponent(id)}`, { method: 'POST' })
      .then((lottery) => {
        const parts = [`活动名称：<strong>${escapeHtml(lottery.title)}</strong>`];
        if (lottery.status === 'drawn') parts.push('该活动已经开奖');
        else if (lottery.status === 'closed') parts.push('报名已截止，等待开奖');
        else parts.push(`报名截止：${escapeHtml(lottery.closeAt)}`);
        parts.push(`已有 ${lottery.participants.length} 人参与`);
        joinBanner.innerHTML = `已为你自动填入活动 ID：<code>${escapeHtml(id)}</code>。${parts.join('，')}。${joinedLocally(id) ? '本机记录显示你已经参加过这场活动了。' : ''}`;
        const codeInput = document.getElementById('join-code');
        if (lottery.status === 'drawn' || lottery.status === 'closed') {
          document.querySelector('#form-join button[type="submit"]').disabled = true;
        }
        codeInput.focus();
      })
      .catch((err) => {
        joinBanner.classList.add('banner-error');
        joinBanner.innerHTML = `活动 ID <code>${escapeHtml(id)}</code> 不存在或已失效：${escapeHtml(err.message)}`;
      });
  }

  (function handleJoinParam() {
    const params = new URLSearchParams(window.location.search);
    const id = (params.get('join') || params.get('id') || '').trim();
    if (!id) return;
    switchTo('join');
    document.getElementById('join-id').value = id;
    loadJoinBanner(id);
  })();

  // ---------- API 文档交互 ----------
  document.querySelectorAll('[data-api-language]').forEach((button) => {
    button.addEventListener('click', () => {
      activeApiLanguage = button.dataset.apiLanguage;
      document.querySelectorAll('[data-api-language]').forEach((item) => {
        item.classList.toggle('active', item === button);
      });
      renderApiCode();
    });
  });

  document.getElementById('btn-copy-api-code').addEventListener('click', async (event) => {
    const code = document.getElementById('api-code-output').textContent;
    const done = await copyText(code);
    const button = event.currentTarget;
    button.textContent = done ? '已复制 ✓' : '复制失败';
    setTimeout(() => {
      button.textContent = '复制代码';
    }, 1600);
  });

  renderApiDocs();

  // 首次加载列表
  loadList();
})();
