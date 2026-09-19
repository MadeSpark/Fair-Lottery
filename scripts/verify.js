#!/usr/bin/env node
/**
 * 独立本地验证脚本（零依赖，只用 Node.js 内置的 crypto 模块）
 * ------------------------------------------------------------
 * 目的：任何人，包括不信任本系统开发者的第三方，都可以：
 *   1. 从 POST /api/lotteries/:id 接口下载某场抽奖的完整公开数据
 *      （或从网页上的"下载验证数据"按钮下载 JSON 文件）
 *   2. 在自己电脑上，不联网、不依赖本项目任何代码，只用这一个文件，
 *      重新计算一遍开奖过程
 *   3. 对比自己算出的中奖名单和官方公布的是否完全一致
 *
 * 用法：
 *   node scripts/verify.js path/to/lottery-data.json
 *   或者
 *   node scripts/verify.js https://your-domain.com/api/lotteries/xxxx
 *
 * 本脚本故意不 require 项目内的 src/lib/fairness.js，
 * 而是把算法逐字重新实现一遍，这样即使原项目代码被人做了手脚，
 * 只要这份独立脚本和文档公开、算法说明清楚，任何人都能自己核实。
 * （当然，这也意味着一旦 src/lib/fairness.js 有算法更新，必须同步
 * 更新这个文件，否则两边会算出不同结果——这是有意为之的“双实现互相
 * 校验”设计，能帮助及早发现实现 bug。）
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function buildInitialSeed({ commitHash, createdAt, extraEntropy = '' }) {
  return sha256Hex(`INIT|${commitHash}|${createdAt}|${extraEntropy}`);
}

function chainAppend(prevHash, entry) {
  const { code, index, joinedAt, deviceHash } = entry;
  // v1（历史活动，无设备标识）：[prevHash, index, code, joinedAt]
  // v2（含设备标识）：[prevHash, index, code, joinedAt, deviceHash]
  const payload = deviceHash
    ? [prevHash, index, code, joinedAt, deviceHash]
    : [prevHash, index, code, joinedAt];
  return sha256Hex(JSON.stringify(payload));
}

function replayChain(initialSeed, entries) {
  let head = initialSeed;
  for (const entry of entries) {
    head = chainAppend(head, entry);
  }
  return head;
}

function buildFinalSeed({ commitHash, secret, chainHead, externalRandomness = '' }) {
  return sha256Hex(`FINAL|${commitHash}|${secret}|${chainHead}|${externalRandomness}`);
}

function createByteStream(seedHex) {
  const seedBuf = Buffer.from(seedHex, 'hex');
  let counter = 0;
  return function next() {
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeUInt32BE(counter, 4);
    counter += 1;
    return sha256Buf(Buffer.concat([seedBuf, counterBuf]));
  };
}

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
    const bitsNeeded = Math.ceil(Math.log2(maxExclusive));
    const bytesNeeded = Math.max(1, Math.ceil(bitsNeeded / 8));
    const maxRange = Math.pow(2, bytesNeeded * 8);
    const limit = maxRange - (maxRange % maxExclusive);

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
    }
  };
}

function seededShuffle(array, seedHex) {
  const arr = array.slice();
  const uniformInt = createUniformIntGenerator(seedHex);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = uniformInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadJson(source, method = 'POST') {
  if (/^https?:\/\//i.test(source)) {
    return new Promise((resolve, reject) => {
      const lib = source.startsWith('https') ? https : http;
      const req = lib.request(source, { method }, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              resolve(json.data || json);
            } catch (e) {
              reject(e);
            }
          });
        });
      req.on('error', reject);
      req.end();
    });
  }
  const raw = fs.readFileSync(source, 'utf8');
  const json = JSON.parse(raw);
  return json.data || json;
}

function fail(msg) {
  console.error(`✗ 校验失败: ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error('用法: node scripts/verify.js <本地json文件路径 或 API地址>');
    process.exit(1);
  }

  const lottery = await loadJson(source);
  console.log(`\n=== 抽奖活动: ${lottery.title} (ID: ${lottery.id}) ===\n`);

  if (lottery.status !== 'drawn') {
    console.error('该抽奖尚未开奖，暂无法验证结果（可以验证参与者链的完整性）。');
  }

  let allPassed = true;

  // 1. 校验密钥承诺
  if (lottery.secret) {
    const recomputedCommit = sha256Hex(lottery.secret);
    if (recomputedCommit === lottery.commitHash) {
      ok(`密钥承诺校验通过：SHA256(secret) = commitHash = ${lottery.commitHash}`);
    } else {
      fail(`密钥承诺不匹配！SHA256(secret)=${recomputedCommit}，但公开的 commitHash=${lottery.commitHash}`);
      allPassed = false;
    }
  } else {
    console.log('（未开奖，暂无 secret 可校验承诺）');
  }

  // 2. 校验初始种子
  const extraEntropy = lottery.externalRandomness
    ? `drand:${lottery.externalRandomness.targetRound || 'na'}`
    : '';
  const recomputedInitialSeed = buildInitialSeed({
    commitHash: lottery.commitHash,
    createdAt: lottery.createdAt,
    extraEntropy,
  });
  if (recomputedInitialSeed === lottery.initialSeed) {
    ok(`初始种子校验通过: ${lottery.initialSeed}`);
  } else {
    fail(`初始种子不匹配！算出=${recomputedInitialSeed}，公开=${lottery.initialSeed}`);
    allPassed = false;
  }

  // 3. 重放参与者哈希链（含设备标识，设备标识也进链，删改任何一条都对不上）
  const entries = (lottery.participants || []).map(({ code, index, joinedAt, deviceHash }) => ({
    code,
    index,
    joinedAt,
    deviceHash,
  }));
  const recomputedChainHead = replayChain(recomputedInitialSeed, entries);
  if (recomputedChainHead === lottery.chainHead) {
    ok(`参与者哈希链校验通过（共 ${entries.length} 人），链头 = ${lottery.chainHead}`);
  } else {
    fail(`哈希链链头不匹配！算出=${recomputedChainHead}，公开=${lottery.chainHead}`);
    allPassed = false;
  }

  // 逐位校验每个参与者的收据
  let head = recomputedInitialSeed;
  let receiptMismatch = 0;
  for (const p of lottery.participants || []) {
    head = chainAppend(head, {
      code: p.code,
      index: p.index,
      joinedAt: p.joinedAt,
      deviceHash: p.deviceHash,
    });
    if (p.receipt && head !== p.receipt) {
      receiptMismatch++;
      console.error(`  ✗ 第 ${p.index} 位参与者（编号 ${p.code}）收据不匹配`);
    }
  }
  if (receiptMismatch === 0) {
    ok(`全部 ${entries.length} 份参与收据逐位校验通过`);
  } else {
    fail(`${receiptMismatch} 份参与收据校验失败`);
    allPassed = false;
  }

  // 3.1 设备唯一性：同一活动中同一台设备不应出现两次
  const deviceHashes = (lottery.participants || []).map((p) => p.deviceHash).filter(Boolean);
  if (deviceHashes.length > 0) {
    const uniqueDevices = new Set(deviceHashes);
    if (uniqueDevices.size === deviceHashes.length) {
      ok(`设备唯一性校验通过：${deviceHashes.length} 条参与记录来自 ${uniqueDevices.size} 台不同设备`);
    } else {
      const seen = new Set();
      const duplicated = new Set();
      for (const h of deviceHashes) {
        if (seen.has(h)) duplicated.add(h);
        seen.add(h);
      }
      fail(`发现有 ${duplicated.size} 台设备在同一活动中重复参与（共 ${deviceHashes.length - uniqueDevices.size} 条重复记录）`);
      allPassed = false;
    }
  } else {
    console.log('（该活动创建于设备校验上线之前，或未记录设备标识，跳过设备唯一性校验）');
  }

  if (lottery.status === 'drawn') {
    // 4. 校验最终种子
    const externalValue =
      lottery.externalRandomness && lottery.externalRandomness.status === 'fetched'
        ? lottery.externalRandomness.value
        : '';
    const recomputedFinalSeed = buildFinalSeed({
      commitHash: lottery.commitHash,
      secret: lottery.secret,
      chainHead: recomputedChainHead,
      externalRandomness: externalValue,
    });
    if (recomputedFinalSeed === lottery.finalSeed) {
      ok(`最终种子校验通过: ${lottery.finalSeed}`);
    } else {
      fail(`最终种子不匹配！算出=${recomputedFinalSeed}，公开=${lottery.finalSeed}`);
      allPassed = false;
    }

    // 5. 重新洗牌并比对结果
    const codes = (lottery.participants || []).map((p) => p.code);
    const recomputedShuffled = seededShuffle(codes, recomputedFinalSeed);
    const shuffledMatches = JSON.stringify(recomputedShuffled) === JSON.stringify(lottery.shuffledOrder);
    if (shuffledMatches) {
      ok('完整洗牌顺序与公开数据完全一致');
    } else {
      fail('洗牌顺序不一致！');
      allPassed = false;
    }

    const recomputedWinners = recomputedShuffled.slice(0, lottery.winnerCount);
    const winnersMatch = JSON.stringify(recomputedWinners) === JSON.stringify(lottery.winners);
    if (winnersMatch) {
      ok(`中奖名单校验通过，共 ${recomputedWinners.length} 人：`);
      recomputedWinners.forEach((w, i) => console.log(`   ${i + 1}. ${w}`));
    } else {
      fail('中奖名单不一致！');
      allPassed = false;
    }

    // 5.1 额外中奖名单：紧跟正式中奖者之后的若干位，同样必须完全可复现
    const extraDrawCount = lottery.extraDrawCount || 0;
    if (extraDrawCount > 0) {
      const recomputedExtra = recomputedShuffled.slice(
        recomputedWinners.length,
        recomputedWinners.length + extraDrawCount
      );
      const extraMatch = JSON.stringify(recomputedExtra) === JSON.stringify(lottery.extraWinners || []);
      if (extraMatch) {
        ok(`额外中奖名单校验通过，共 ${recomputedExtra.length} / ${extraDrawCount} 人：`);
        recomputedExtra.forEach((w, i) => console.log(`   额外 ${i + 1}. ${w}`));
      } else {
        fail('额外中奖名单不一致！');
        allPassed = false;
      }
    }

    if (lottery.externalRandomness) {
      console.log('\n外部公开随机数信标 (drand) 信息：');
      console.log(`  状态: ${lottery.externalRandomness.status}`);
      if (lottery.externalRandomness.status === 'fetched') {
        console.log(`  轮次: ${lottery.externalRandomness.targetRound}`);
        console.log(`  随机值: ${lottery.externalRandomness.value}`);
        const drandUrl = 'https://api.drand.sh/public/' + lottery.externalRandomness.targetRound;
        try {
          const publicRound = await loadJson(drandUrl, 'GET');
          if (
            publicRound.round === lottery.externalRandomness.targetRound &&
            publicRound.randomness === lottery.externalRandomness.value
          ) {
            ok(`drand 公开接口交叉校验通过: ${drandUrl}`);
          } else {
            fail(`drand 公开接口返回值与活动记录不一致: ${drandUrl}`);
            allPassed = false;
          }
        } catch (e) {
          console.warn(`  ! 无法访问 drand 公开接口，跳过在线交叉校验: ${e.message}`);
          console.warn(`  ! 可在网络恢复后访问 ${drandUrl} 核实。`);
        }
      } else {
        console.log(`  说明: ${lottery.externalRandomness.error || '未使用'}`);
      }
    }
  }

  console.log('\n' + (allPassed ? '=== 全部校验通过 ✓ ===' : '=== 存在校验失败项 ✗ ==='));
  if (!allPassed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('验证脚本执行出错：', e.message);
  process.exit(1);
});
