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
const MAX_EXTRA_WINNERS = 10000;

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
    chainVersion: 2, // v2：参与者记录带 deviceHash（设备标识），一起进哈希链
    requireDevice: true, // 创建于本次升级之后的活动，参与时必须提供设备指纹
    externalRandomness,
    participants: [], // { code, index, joinedAt, deviceHash, receipt }
    drawnAt: null,
    finalSeed: null,
    shuffledOrder: null, // 完整洗牌顺序（脱敏后的 code 列表），开奖后公开，供逐位校验
    winners: null,
    extraDrawCount: 0, // 已请求的额外抽取人数（开奖时指定，之后只增不减）
    extraWinners: null, // 额外中奖名单，紧跟正式中奖者之后的若干位
  };

  await store.withLottery(id, async () => ({ __data: data }));
  return publicView(data);
}

/**
 * 参与抽奖：提交唯一编号。
 *
 * 除编号外还接收前端上报的设备指纹哈希。服务端用活动 ID 加盐派生出
 * 本活动专属的设备标识，并强制"同一活动内一台设备只能参与一次"，
 * 用来拦住批量重复提交刷概率的行为。不同活动盐不同，互不影响。
 *
 * @param {string} id 活动 ID
 * @param {string} code 参与编号
 * @param {string} [rawFingerprint] 前端设备指纹哈希（十六进制）
 */
async function joinLottery(id, code, rawFingerprint) {
  code = sanitizeString(code, MAX_CODE_LEN, '参与编号');

  let fingerprint = null;
  if (rawFingerprint !== undefined && rawFingerprint !== null && String(rawFingerprint).trim() !== '') {
    fingerprint = String(rawFingerprint).trim().toLowerCase();
    if (!/^[0-9a-f]{16,128}$/.test(fingerprint)) {
      throw new LotteryError('设备指纹格式不正确，请刷新页面后重试', 400, 'INVALID_DEVICE_FINGERPRINT');
    }
  }

  const result = await store.withLottery(id, async (data) => {
    if (!data) throw new LotteryError('抽奖活动不存在', 404, 'NOT_FOUND');
    if (data.status === 'drawn') throw new LotteryError('该抽奖已开奖，无法再参与', 409, 'ALREADY_DRAWN');
    if (Date.now() >= new Date(data.closeAt).getTime()) {
      throw new LotteryError('报名已截止，无法再参与', 409, 'REGISTRATION_CLOSED');
    }
    if (data.requireDevice && !fingerprint) {
      throw new LotteryError(
        '本活动需要浏览器设备校验，请通过活动链接在浏览器中正常参与，不要用脚本直接提交。',
        400,
        'DEVICE_FINGERPRINT_REQUIRED'
      );
    }
    if (data.participants.some((p) => p.code === code)) {
      throw new LotteryError('该编号已被使用，请换一个唯一编号', 409, 'DUPLICATE_CODE');
    }

    // 设备去重：同一活动内一台设备只能提交一次
    let deviceHash = null;
    if (fingerprint) {
      deviceHash = fairness.deriveDeviceHash(fingerprint, data.id || id);
      if (data.participants.some((p) => p.deviceHash && p.deviceHash === deviceHash)) {
        throw new LotteryError(
          '这台设备已经参加过本场抽奖了。每个设备在同一活动中只能参与一次（不同活动之间不受影响）。',
          409,
          'DEVICE_ALREADY_JOINED'
        );
      }
    }

    if (data.participants.length >= MAX_PARTICIPANTS) {
      throw new LotteryError('参与人数已达上限', 409, 'FULL');
    }

    const index = data.participants.length;
    const joinedAt = nowIso();
    const chainEntry = { code, index, joinedAt };
    if (deviceHash) chainEntry.deviceHash = deviceHash;
    const newHead = fairness.chainAppend(data.chainHead, chainEntry);

    const entry = { code, index, joinedAt, receipt: newHead };
    if (deviceHash) entry.deviceHash = deviceHash;
    data.participants.push(entry);
    data.chainHead = newHead;

    return { __data: data, __return: entry };
  });

  return result;
}

/**
 * 开奖。
 *
 * @param {string} id 活动 ID
 * @param {number} [extraDrawCount] 额外抽取人数：在「中奖人数」之外再追加抽出的人数。
 *
 * 额外抽取只从同一份洗牌序列的后半段顺延取号，取的永远是
 * shuffledOrder[winnerCount .. winnerCount + extraDrawCount)，
 * 所以无论抽多少，正式中奖名单一个都不会变——它只是追加。
 *
 * 已经开过奖的活动也可以再次调用本接口追加额外抽取，但只能调大不能调小，
 * 正式中奖名单同样不受影响。这样"开完奖又临时想多送几个名额"就不用重新开奖。
 */
async function drawLottery(id, extraDrawCount) {
  // 参数校验放在进写队列之前，非法输入直接拒绝
  let requestedExtra = null;
  if (extraDrawCount !== undefined && extraDrawCount !== null && extraDrawCount !== '') {
    requestedExtra = Number(extraDrawCount);
    if (!Number.isInteger(requestedExtra) || requestedExtra < 0) {
      throw new LotteryError('额外抽取人数必须是不小于 0 的整数');
    }
    if (requestedExtra > MAX_EXTRA_WINNERS) {
      throw new LotteryError(`额外抽取人数不能超过 ${MAX_EXTRA_WINNERS}`);
    }
  }

  const result = await store.withLottery(id, async (data) => {
    if (!data) throw new LotteryError('抽奖活动不存在', 404, 'NOT_FOUND');

    // 已开奖：只允许「只增不减」地追加额外抽取，正式中奖名单保持原样
    if (data.status === 'drawn') {
      const currentExtra = data.extraDrawCount || 0;
      if (requestedExtra === null) {
        throw new LotteryError('该抽奖已经开过奖了', 409, 'ALREADY_DRAWN');
      }
      if (requestedExtra <= currentExtra) {
        // 没有要求新的名额，按重复点击处理，幂等返回当前结果
        return { __return: publicView(data) };
      }
      data.extraDrawCount = requestedExtra;
      data.extraWinners = data.shuffledOrder.slice(data.winnerCount, data.winnerCount + requestedExtra);
      return { __data: data, __return: publicView(data) };
    }

    if (Date.now() < new Date(data.closeAt).getTime()) {
      throw new LotteryError(`报名尚未截止，请在 ${data.closeAt} 后开奖`, 409, 'REGISTRATION_OPEN');
    }
    if (data.participants.length === 0) {
      throw new LotteryError('还没有人参与，无法开奖', 409, 'NO_PARTICIPANTS');
    }

    // 完整性自检：从初始种子重放整条链，必须与当前 chainHead 一致，
    // 否则说明数据被篡改或存在 bug，拒绝开奖。
    // 注意 deviceHash 也是链的一部分，必须原样带入，否则新活动会误报链头不一致。
    const replayed = fairness.replayChain(
      data.initialSeed,
      data.participants.map(({ code, index, joinedAt, deviceHash }) => ({
        code,
        index,
        joinedAt,
        deviceHash,
      }))
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

    const extraWanted = requestedExtra === null ? 0 : requestedExtra;
    const codes = data.participants.map((p) => p.code);
    const { shuffledOrder, winners, extraWinners } = fairness.drawWinners(
      codes,
      finalSeed,
      data.winnerCount,
      extraWanted
    );

    data.status = 'drawn';
    data.drawnAt = drawnAt;
    data.secret = data.secret_plain; // 揭示密钥
    data.finalSeed = finalSeed;
    data.shuffledOrder = shuffledOrder;
    data.winners = winners;
    data.extraDrawCount = extraWanted;
    data.extraWinners = extraWinners;
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
  // 兼容本次升级之前创建的历史活动
  if (rest.extraDrawCount === undefined) rest.extraDrawCount = 0;
  if (rest.extraWinners === undefined) rest.extraWinners = null;
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
    extraDrawCount: data.extraDrawCount || 0,
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
