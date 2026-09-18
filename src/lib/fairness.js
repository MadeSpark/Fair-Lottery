/**
 * 公平抽奖核心算法模块
 * ------------------------------------------------------------
 * 设计目标：任何人拿到公开数据后，用本模块（或独立的 scripts/verify.js）
 * 都能在本地重新算出完全相同的结果，无需信任服务器。
 *
 * 核心机制：
 * 1. 承诺-揭示（Commit-Reveal）
 *    创建抽奖时，服务器立即生成 32 字节随机密钥 secret，
 *    并公开 commitHash = SHA256(secret)。
 *    开奖前 secret 保密，开奖时才公开 secret，任何人都能验证
 *    SHA256(secret) === commitHash，证明密钥在创建时就已固定，
 *    不是看到参与者名单后才选的。
 *
 * 2. 哈希链种子（Hash Chain）
 *    每个参与者加入时，把当前种子、参与者编号、加入序号、加入时间
 *    一起哈希，生成下一个种子。每加入一人，种子必然变化，且
 *    整条链可以被逐步重放校验，任何一步被篡改都会导致后续哈希不一致。
 *
 * 3. 最终混合种子
 *    finalSeed = SHA256(commitHash + secret + chainHead + [可选:外部公开随机数])
 *    不把服务器开奖时间放入种子，避免组织者通过挑选开奖时间试算结果。
 *
 * 4. 无偏随机流 + Fisher-Yates 洗牌
 *    用 finalSeed 作为 HMAC-DRBG 风格的计数器模式随机流生成器，
 *    对参与者数组做 Fisher-Yates 洗牌，取前 N 个作为中奖者。
 * ------------------------------------------------------------
 */

const crypto = require('crypto');

const ENCODING = 'hex';

/** SHA256 十六进制摘要 */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest(ENCODING);
}

/** SHA256 摘要，支持 Buffer 输入，返回 Buffer */
function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

/** 生成 32 字节随机密钥（十六进制字符串） */
function generateSecret() {
  return crypto.randomBytes(32).toString(ENCODING);
}

/** 生成初始种子：结合密钥承诺哈希 + 创建时间 + 可选的外部随机源说明 */
function buildInitialSeed({ commitHash, createdAt, extraEntropy = '' }) {
  return sha256Hex(`INIT|${commitHash}|${createdAt}|${extraEntropy}`);
}

/**
 * 哈希链：向种子链中加入一个参与者，返回新的链头哈希。
 *
 * 链格式有两个版本，靠记录里有没有 deviceHash 自动区分，因此历史数据
 * 依然可以逐位复现：
 *   v1: [prevHash, index, code, joinedAt]
 *   v2: [prevHash, index, code, joinedAt, deviceHash]
 *
 * 设备标识（deviceHash）也进链，是为了防止组织者事后偷偷删掉某个设备
 * 的重复提交记录——删掉任何一条，后面所有哈希都会连锁对不上。
 *
 * @param {string} prevHash 上一个链头哈希
 * @param {object} entry { code, index, joinedAt, deviceHash? }
 * @returns {string} 新的链头哈希
 */
function chainAppend(prevHash, entry) {
  const { code, index, joinedAt, deviceHash } = entry;
  const payload = deviceHash
    ? [prevHash, index, code, joinedAt, deviceHash]
    : [prevHash, index, code, joinedAt];
  return sha256Hex(JSON.stringify(payload));
}

/**
 * 由前端上报的设备指纹派生本活动内的设备标识。
 *
 * 关键点：用活动 ID 当盐，所以同一台设备在不同活动里算出的 deviceHash
 * 完全不同，无法被跨活动关联追踪；但在同一活动内稳定不变，可以直接
 * 用于"一个设备只能参加一次"的判定。公开这个值等于公开"这台设备参过
 * 这场活动"，不会泄露指纹原文，也不会暴露它在别处参加过什么。
 *
 * @param {string} rawFingerprint 前端上报的指纹哈希（十六进制）
 * @param {string} salt 活动 ID
 */
function deriveDeviceHash(rawFingerprint, salt) {
  return sha256Hex(`DEVICE|${salt}|${rawFingerprint}`);
}

/**
 * 从头重放整条参与者链，得到链头哈希。
 * 用于服务器内部增量维护，也用于独立验证脚本从零校验。
 * @param {string} initialSeed
 * @param {Array<{code:string, index:number, joinedAt:string}>} entries 必须已按 index 升序排列
 */
function replayChain(initialSeed, entries) {
  let head = initialSeed;
  for (const entry of entries) {
    head = chainAppend(head, entry);
  }
  return head;
}

/**
 * 计算最终混合种子。所有输入都在参与截止后固定，不能由开奖动作改变。
 */
function buildFinalSeed({ commitHash, secret, chainHead, externalRandomness = '' }) {
  return sha256Hex(`FINAL|${commitHash}|${secret}|${chainHead}|${externalRandomness}`);
}

/**
 * 基于种子的确定性随机字节流生成器（计数器模式：SHA256(seed || counter)）。
 * 返回一个函数，每次调用给出下一个 32 字节 Buffer。
 */
function createByteStream(seedHex) {
  const seedBuf = Buffer.from(seedHex, ENCODING);
  let counter = 0;
  return function next() {
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeUInt32BE(counter, 4);
    counter += 1;
    return sha256Buf(Buffer.concat([seedBuf, counterBuf]));
  };
}

/**
 * 用给定种子生成 [0, maxExclusive) 范围内的均匀分布整数，
 * 使用拒绝采样避免模偏差（modulo bias）。
 */
function createUniformIntGenerator(seedHex) {
  const nextBytes = createByteStream(seedHex);
  let pool = Buffer.alloc(0);
  let poolOffset = 0;

  function ensureBytes(n) {
    while (pool.length - poolOffset < n) {
      const fresh = nextBytes();
      pool = Buffer.concat([pool.slice(poolOffset), fresh]);
      poolOffset = 0;
    }
  }

  return function uniformInt(maxExclusive) {
    if (maxExclusive <= 0) throw new Error('maxExclusive must be > 0');
    if (maxExclusive === 1) return 0;
    // 需要的字节数：能覆盖 maxExclusive 的最小字节数
    const bitsNeeded = Math.ceil(Math.log2(maxExclusive));
    const bytesNeeded = Math.max(1, Math.ceil(bitsNeeded / 8));
    const maxRange = Math.pow(2, bytesNeeded * 8);
    const limit = maxRange - (maxRange % maxExclusive);

    // 拒绝采样循环
    // eslint-disable-next-line no-constant-condition
    while (true) {
      ensureBytes(bytesNeeded);
      let value = 0;
      for (let i = 0; i < bytesNeeded; i++) {
        value = value * 256 + pool[poolOffset + i];
      }
      poolOffset += bytesNeeded;
      if (value < limit) {
        return value % maxExclusive;
      }
      // 落在偏差区间，丢弃重试
    }
  };
}

/**
 * Fisher-Yates 洗牌（确定性，基于种子）。
 * 返回洗牌后的新数组（不修改原数组）。
 */
function seededShuffle(array, seedHex) {
  const arr = array.slice();
  const uniformInt = createUniformIntGenerator(seedHex);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = uniformInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 完整开奖计算：给定参与者列表（按 index 升序）和最终种子，
 * 返回洗牌后的完整顺序。前 winnerCount 个是正式中奖者，
 * 紧跟在后面的 extraWinnerCount 个是额外候补中奖者。
 *
 * 候补名单同样完全由公开数据决定，可以本地复现，不需要"再开一次奖"。
 */
function drawWinners(participants, finalSeed, winnerCount, extraWinnerCount = 0) {
  const shuffled = seededShuffle(participants, finalSeed);
  const winners = shuffled.slice(0, Math.min(winnerCount, shuffled.length));
  const extraWinners = shuffled.slice(winners.length, winners.length + Math.max(0, extraWinnerCount));
  return { shuffledOrder: shuffled, winners, extraWinners };
}

module.exports = {
  sha256Hex,
  generateSecret,
  buildInitialSeed,
  chainAppend,
  deriveDeviceHash,
  replayChain,
  buildFinalSeed,
  createByteStream,
  createUniformIntGenerator,
  seededShuffle,
  drawWinners,
};
