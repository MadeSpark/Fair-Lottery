/**
 * 抽奖业务逻辑层
 * ------------------------------------------------------------
 * 抽奖状态机：
 *   pending（可参与） -> drawn（已开奖）
 *   closed 只作为“已过报名截止时间、但尚未开奖”的对外计算状态，不落盘。
 *
 * 数据结构说明见 createLottery 中的初始对象。
 */

const crypto = require('crypto');
const fairness = require('../lib/fairness');
const drand = require('../lib/drand');
const store = require('../lib/store');

const MAX_TITLE_LEN = 200;
const MAX_CODE_LEN = 100;
const MAX_PARTICIPANTS = 200000;

class LotteryError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function genId() {
  return crypto.randomBytes(9).toString('base64url');
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeString(v, maxLen, fieldName) {
  if (typeof v !== 'string') throw new LotteryError(`${fieldName} 必须是字符串`);
  const trimmed = v.trim();
  if (!trimmed) throw new LotteryError(`${fieldName} 不能为空`);
  if (trimmed.length > maxLen) throw new LotteryError(`${fieldName} 长度不能超过 ${maxLen}`);
  return trimmed;
}

/**
 * 创建抽奖活动。
 * @param {object} opts
 * @param {string} opts.title 活动标题
 * @param {number} opts.winnerCount 中奖人数（创建时锁定）
 * @param {string} opts.closeAt 报名截止时间（ISO 8601，创建时锁定）
 * @param {boolean} opts.useExternalRandomness 是否叠加 drand 公开随机数信标
 */
async function createLottery({ title, winnerCount, closeAt, useExternalRandomness = false }) {
  title = sanitizeString(title, MAX_TITLE_LEN, '活动标题');
  winnerCount = Number(winnerCount);
  if (!Number.isInteger(winnerCount) || winnerCount <= 0) {
    throw new LotteryError('中奖人数必须是正整数');
  }
  if (winnerCount > MAX_PARTICIPANTS) {
    throw new LotteryError('中奖人数超出上限');
  }
  const closeAtDate = new Date(closeAt);
  if (!closeAt || Number.isNaN(closeAtDate.getTime())) {
    throw new LotteryError('报名截止时间必须是有效的 ISO 8601 时间');
  }
  if (closeAtDate.getTime() < Date.now() + 60 * 1000) {
    throw new LotteryError('报名截止时间至少需要在 1 分钟后');
  }
  closeAt = closeAtDate.toISOString();

  const id = genId();
  const secret = fairness.generateSecret();
  const commitHash = fairness.sha256Hex(secret);
  const createdAt = nowIso();

  let externalRandomness = null;
  if (useExternalRandomness) {
    try {
      const lock = await drand.lockRoundAfter(closeAt);
      externalRandomness = {
        provider: 'drand',
        chainHash: lock.chainHash,
        period: lock.period,
        genesisTime: lock.genesisTime,
        targetRound: lock.targetRound,
        status: 'locked', // locked -> fetched
        value: null,
      };
    } catch (e) {
      throw new LotteryError(
        '无法连接 drand 公开随机数网络。请检查服务器外网访问，或关闭公开随机数选项后重试。',
        503,
        'DRAND_UNAVAILABLE'
      );
    }
  }

  const initialSeed = fairness.buildInitialSeed({
    commitHash,
    createdAt,
    extraEntropy: externalRandomness ? `drand:${externalRandomness.targetRound || 'na'}` : '',
  });

  const data = {
    id,
    title,
    winnerCount,
    closeAt,
    status: 'pending', // pending | drawn
    createdAt,
    commitHash, // 公开：密钥承诺
    secret: null, // 开奖前保密，开奖后揭示
    secret_plain: secret, // 内部字段：真实密钥，publicView() 会剔除，开奖后转存到 secret 并删除
    initialSeed,
    chainHead: initialSeed, // 随参与者加入不断推进
    externalRandomness,
    participants: [], // { code, index, joinedAt, receipt }
    drawnAt: null,
    finalSeed: null,
    shuffledOrder: null, // 完整洗牌顺序（脱敏后的 code 列表），开奖后公开，供逐位校验
    winners: null,
  };

  await store.withLottery(id, async () => ({ __data: data }));
  return publicView(data);
}

/**
 * 参与抽奖：提交唯一编号。
 */
async function joinLottery(id, code) {
  code = sanitizeString(code, MAX_CODE_LEN, '参与编号');

  const result = await store.withLottery(id, async (data) => {
    if (!data) throw new LotteryError('抽奖活动不存在', 404, 'NOT_FOUND');
    if (data.status === 'drawn') throw new LotteryError('该抽奖已开奖，无法再参与', 409, 'ALREADY_DRAWN');
    if (Date.now() >= new Date(data.closeAt).getTime()) {
      throw new LotteryError('报名已截止，无法再参与', 409, 'REGISTRATION_CLOSED');
    }
    if (data.participants.some((p) => p.code === code)) {
      throw new LotteryError('该编号已被使用，请换一个唯一编号', 409, 'DUPLICATE_CODE');
    }
    if (data.participants.length >= MAX_PARTICIPANTS) {
      throw new LotteryError('参与人数已达上限', 409, 'FULL');
    }

    const index = data.participants.length;
    const joinedAt = nowIso();
    const newHead = fairness.chainAppend(data.chainHead, { code, index, joinedAt });

    const entry = { code, index, joinedAt, receipt: newHead };
    data.participants.push(entry);
    data.chainHead = newHead;

    return { __data: data, __return: entry };
  });

  return result;
}

/**
 * 开奖。
 */
async function drawLottery(id) {
  const result = await store.withLottery(id, async (data) => {
    if (!data) throw new LotteryError('抽奖活动不存在', 404, 'NOT_FOUND');
    if (data.status === 'drawn') {
      throw new LotteryError('该抽奖已经开过奖了', 409, 'ALREADY_DRAWN');
    }
    if (Date.now() < new Date(data.closeAt).getTime()) {
      throw new LotteryError(`报名尚未截止，请在 ${data.closeAt} 后开奖`, 409, 'REGISTRATION_OPEN');
    }
    if (data.participants.length === 0) {
      throw new LotteryError('还没有人参与，无法开奖', 409, 'NO_PARTICIPANTS');
    }

    // 完整性自检：从初始种子重放整条链，必须与当前 chainHead 一致，
    // 否则说明数据被篡改或存在 bug，拒绝开奖。
    const replayed = fairness.replayChain(
      data.initialSeed,
      data.participants.map(({ code, index, joinedAt }) => ({ code, index, joinedAt }))
    );
    if (replayed !== data.chainHead) {
      throw new LotteryError('数据完整性校验失败，链头不一致，已中止开奖', 500, 'CHAIN_MISMATCH');
    }

    const drawnAt = nowIso();
    let externalRandomnessValue = '';

    if (data.externalRandomness) {
      if (data.externalRandomness.status === 'locked') {
        const fetched = await drand.fetchRoundRandomness(data.externalRandomness.targetRound);
        if (!fetched) {
          throw new LotteryError(
            `公开随机数信标尚未准备好或暂时无法访问，请稍后重试。目标轮次：${data.externalRandomness.targetRound}`,
            503,
            'RANDOMNESS_NOT_READY'
          );
        }
        data.externalRandomness.status = 'fetched';
        data.externalRandomness.value = fetched.randomness;
        data.externalRandomness.signature = fetched.signature;
      }
      if (data.externalRandomness.status !== 'fetched' || !data.externalRandomness.value) {
        throw new LotteryError('公开随机数信标状态无效，已中止开奖', 500, 'INVALID_RANDOMNESS_STATE');
      }
      externalRandomnessValue = data.externalRandomness.value;
    }

    const finalSeed = fairness.buildFinalSeed({
      commitHash: data.commitHash,
      secret: data.secret_plain,
      chainHead: data.chainHead,
      externalRandomness: externalRandomnessValue,
    });

    const codes = data.participants.map((p) => p.code);
    const { shuffledOrder, winners } = fairness.drawWinners(codes, finalSeed, data.winnerCount);

    data.status = 'drawn';
    data.drawnAt = drawnAt;
    data.secret = data.secret_plain; // 揭示密钥
    data.finalSeed = finalSeed;
    data.shuffledOrder = shuffledOrder;
    data.winners = winners;
    delete data.secret_plain;

    return { __data: data, __return: publicView(data) };
  });

  return result;
}

async function getLottery(id) {
  const data = store.readSync(id);
  if (!data) throw new LotteryError('抽奖活动不存在', 404, 'NOT_FOUND');
  return publicView(data);
}

async function listLotteries() {
  const ids = store.listIds();
  const items = [];
  for (const id of ids) {
    const data = store.readSync(id);
    if (data) items.push(publicSummary(data));
  }
  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return items;
}

/** 对外公开视图：不泄露尚未揭示的 secret_plain */
function publicView(data) {
  const { secret_plain, ...rest } = data;
  if (rest.status === 'pending' && Date.now() >= new Date(rest.closeAt).getTime()) {
    rest.status = 'closed';
  }
  return rest;
}

function publicSummary(data) {
  return {
    id: data.id,
    title: data.title,
    status: data.status === 'pending' && Date.now() >= new Date(data.closeAt).getTime() ? 'closed' : data.status,
    winnerCount: data.winnerCount,
    participantCount: data.participants.length,
    createdAt: data.createdAt,
    closeAt: data.closeAt,
    drawnAt: data.drawnAt,
  };
}

module.exports = {
  LotteryError,
  createLottery,
  joinLottery,
  drawLottery,
  getLottery,
  listLotteries,
};
