(function () {
  'use strict';

  const API_BASE = '/api';

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
      throw new Error(json.error || `请求失败 (HTTP ${res.status})`);
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
      showBox(
        createResult,
        `
        <p>抽奖创建成功！请把下面的<strong>活动 ID</strong>分享给参与者。</p>
        <dl class="kv">
          <dt>活动 ID</dt><dd>${escapeHtml(lottery.id)}</dd>
          <dt>标题</dt><dd>${escapeHtml(lottery.title)}</dd>
          <dt>中奖人数</dt><dd>${lottery.winnerCount}</dd>
          <dt>报名截止</dt><dd>${escapeHtml(lottery.closeAt)}</dd>
          <dt>密钥承诺</dt><dd>${escapeHtml(lottery.commitHash)}</dd>
          <dt>创建时间</dt><dd>${escapeHtml(lottery.createdAt)}</dd>
        </dl>
        <p style="color:#6b7280;font-size:13px">密钥承诺（commitHash）已经在此刻公开锁定，开奖时会揭示真实密钥，任何人都能验证两者是否吻合。报名截止前不能开奖，截止时间后也不能再加入。</p>
        <button class="btn btn-secondary" data-goto-join="${escapeHtml(lottery.id)}">去参与这场抽奖</button>
        <button class="btn btn-secondary" data-goto-view="${escapeHtml(lottery.id)}">查看/开奖</button>
        `
      );
    } catch (err) {
      showBox(createResult, errorHtml(err.message));
    }
  });

  // ---------- 参与抽奖 ----------
  const formJoin = document.getElementById('form-join');
  const joinResult = document.getElementById('join-result');

  formJoin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('join-id').value.trim();
    const code = document.getElementById('join-code').value.trim();

    showBox(joinResult, '正在提交...');
    try {
      const entry = await api(`/lotteries/${encodeURIComponent(id)}/participants`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
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
        `
      );
    } catch (err) {
      showBox(joinResult, errorHtml(err.message));
    }
  });

  // ---------- 查看 / 开奖 ----------
  const formView = document.getElementById('form-view');
  const viewResult = document.getElementById('view-result');
  let currentLotteryId = null;

  formView.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('view-id').value.trim();
    await loadAndRenderLottery(id);
  });

  async function loadAndRenderLottery(id) {
    currentLotteryId = id;
    showBox(viewResult, '正在查询...');
    try {
      const lottery = await api(`/lotteries/${encodeURIComponent(id)}`);
      renderLotteryDetail(lottery);
    } catch (err) {
      showBox(viewResult, errorHtml(err.message));
    }
  }

  function renderLotteryDetail(lottery) {
    const statusBadge =
      lottery.status === 'drawn'
        ? '<span class="badge badge-drawn">已开奖</span>'
        : lottery.status === 'closed'
          ? '<span class="badge badge-closed">报名已截止</span>'
          : '<span class="badge badge-pending">进行中</span>';

    const participantItems = lottery.participants
      .map((p) => `<li>#${p.index + 1} - ${escapeHtml(p.code)} (${escapeHtml(p.joinedAt)})</li>`)
      .join('');

    let winnersHtml = '';
    let drawBtnHtml = '';
    if (lottery.status === 'drawn') {
      const winnerItems = lottery.winners.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
      winnersHtml = `
        <h3>中奖名单</h3>
        <ol class="winner-list">${winnerItems}</ol>
        <dl class="kv">
          <dt>开奖时间</dt><dd>${escapeHtml(lottery.drawnAt)}</dd>
          <dt>揭示密钥</dt><dd>${escapeHtml(lottery.secret)}</dd>
          <dt>最终种子</dt><dd>${escapeHtml(lottery.finalSeed)}</dd>
        </dl>
      `;
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
    } else if (lottery.status === 'closed') {
      drawBtnHtml = `<button class="btn" id="btn-draw">立即开奖</button>`;
    } else {
      drawBtnHtml = `<p style="color:#6b7280">报名进行中，截止时间后才能开奖：${escapeHtml(lottery.closeAt)}</p>`;
    }

    showBox(
      viewResult,
      `
      <div class="kv">
        <dt>标题</dt><dd>${escapeHtml(lottery.title)} ${statusBadge}</dd>
        <dt>活动 ID</dt><dd>${escapeHtml(lottery.id)}</dd>
        <dt>中奖人数</dt><dd>${lottery.winnerCount}</dd>
        <dt>参与人数</dt><dd>${lottery.participants.length}</dd>
        <dt>报名截止</dt><dd>${escapeHtml(lottery.closeAt)}</dd>
        <dt>密钥承诺</dt><dd>${escapeHtml(lottery.commitHash)}</dd>
        <dt>当前链头</dt><dd>${escapeHtml(lottery.chainHead)}</dd>
      </div>
      ${drawBtnHtml}
      ${winnersHtml}
      <details style="margin-top:16px">
        <summary>查看全部参与者（${lottery.participants.length} 人）</summary>
        <ul class="participant-list">${participantItems}</ul>
      </details>
      <div style="margin-top:16px">
        <button class="btn btn-secondary" id="btn-download">下载完整验证数据 (JSON)</button>
        <button class="btn btn-secondary" id="btn-refresh-detail">刷新</button>
      </div>
      <p style="color:#6b7280;font-size:13px;margin-top:12px">
        下载数据后，在终端运行 <code>node scripts/verify.js 文件名.json</code> 即可本地独立验证开奖结果。
      </p>
      `
    );

    const drawBtn = document.getElementById('btn-draw');
    if (drawBtn) {
      drawBtn.addEventListener('click', async () => {
        drawBtn.disabled = true;
        drawBtn.textContent = '开奖中...';
        try {
          const updated = await api(`/lotteries/${encodeURIComponent(lottery.id)}/draw`, { method: 'POST' });
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

  // ---------- 跳转按钮（创建成功后） ----------
  document.addEventListener('click', (e) => {
    const gotoJoinId = e.target.getAttribute && e.target.getAttribute('data-goto-join');
    const gotoViewId = e.target.getAttribute && e.target.getAttribute('data-goto-view');
    if (gotoJoinId) {
      switchTo('join');
      document.getElementById('join-id').value = gotoJoinId;
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
      const items = await api('/lotteries');
      if (items.length === 0) {
        listResult.innerHTML = '<p style="color:#6b7280">还没有任何抽奖活动。</p>';
        return;
      }
      listResult.innerHTML = items
        .map(
          (item) => `
        <div class="lottery-card" data-id="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.title)}</strong>
           ${item.status === 'drawn' ? '<span class="badge badge-drawn">已开奖</span>' : item.status === 'closed' ? '<span class="badge badge-closed">报名已截止</span>' : '<span class="badge badge-pending">进行中</span>'}
          <div style="color:#6b7280;font-size:13px;margin-top:4px">
            ID: ${escapeHtml(item.id)} | 参与人数: ${item.participantCount} | 中奖人数: ${item.winnerCount} | 截止于 ${escapeHtml(item.closeAt)}
          </div>
        </div>
      `
        )
        .join('');
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

  // 首次加载列表
  loadList();
})();
