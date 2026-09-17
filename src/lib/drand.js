/**
 * drand 公开随机数信标（可选增强层）
 * ------------------------------------------------------------
 * drand（https://drand.love）是一个多机构联合运营的、门限签名驱动的
 * 公开随机数信标网络。每 30 秒产生一个新的随机数（round），且在该
 * round 到来之前，包括运营方自己都无法预测其值。
 *
 * 用法：创建抽奖时，锁定报名截止时间之后的 round 号，保证报名结束前
 * 这个 round 尚未产生、无法被任何人预测或选择。开奖时必须从公开接口
 * 取到该值才允许开奖，不能悄悄降级，否则会重新引入组织者可预测结果的
 * 问题。
 *
 * 任何第三方都可以自行访问 drand 公开 API 核实该 round 的随机数，
 * 不需要信任本系统。
 */

const https = require('https');

const DRAND_INFO_URL = 'https://api.drand.sh/info';
const DRAND_ROUND_URL = (round) => `https://api.drand.sh/public/${round}`;
const REQUEST_TIMEOUT_MS = 5000;

function httpGetJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('drand 请求超时')));
    req.on('error', reject);
  });
}

let cachedInfo = null;

async function getNetworkInfo() {
  if (cachedInfo) return cachedInfo;
  cachedInfo = await httpGetJson(DRAND_INFO_URL);
  return cachedInfo;
}

/** 计算当前时刻对应的 round 号 */
function roundAtTime(info, unixSeconds) {
  const { genesis_time, period } = info;
  if (unixSeconds < genesis_time) return 1;
  return Math.floor((unixSeconds - genesis_time) / period) + 1;
}

/**
 * 创建抽奖时调用：锁定 participationCloseAt 之后的第一个 drand round。
 * 这样外部随机数直到报名截止后才产生，组织者无法在报名期内试算结果。
 */
async function lockRoundAfter(participationCloseAt) {
  const info = await getNetworkInfo();
  const closeAtSeconds = Math.floor(new Date(participationCloseAt).getTime() / 1000);
  const targetRound = roundAtTime(info, closeAtSeconds) + 1;
  return {
    chainHash: info.hash,
    period: info.period,
    genesisTime: info.genesis_time,
    targetRound,
  };
}

/** 开奖时调用：尝试拉取锁定的 round 的随机数。失败返回 null。 */
async function fetchRoundRandomness(round) {
  try {
    const data = await httpGetJson(DRAND_ROUND_URL(round));
    if (data && data.round === round && data.randomness) {
      return { round: data.round, randomness: data.randomness, signature: data.signature };
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  getNetworkInfo,
  roundAtTime,
  lockRoundAfter,
  fetchRoundRandomness,
};
