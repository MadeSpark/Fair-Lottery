const express = require('express');
const lotteryService = require('../services/lotteryService');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

/**
 * POST /api/lotteries
 * body: { title, winnerCount, closeAt, useExternalRandomness? }
 * 创建抽奖活动，立即返回公开的 commitHash（密钥承诺）。
 */
router.post(
  '/lotteries',
  asyncHandler(async (req, res) => {
    const { title, winnerCount, closeAt } = req.body || {};
    const useExternalRandomness = req.body && req.body.useExternalRandomness !== false;
    const lottery = await lotteryService.createLottery({
      title,
      winnerCount,
      closeAt,
      useExternalRandomness: !!useExternalRandomness,
    });
    res.status(201).json({ ok: true, data: lottery });
  })
);

/**
 * POST /api/lotteries/list
 * 列出所有抽奖活动摘要。
 */
router.post(
  '/lotteries/list',
  asyncHandler(async (req, res) => {
    const items = await lotteryService.listLotteries();
    res.json({ ok: true, data: items });
  })
);

/**
 * POST /api/lotteries/:id
 * 获取某个抽奖活动的完整公开数据（用于展示和本地验证）。
 */
router.post(
  '/lotteries/:id',
  asyncHandler(async (req, res) => {
    const lottery = await lotteryService.getLottery(req.params.id);
    res.json({ ok: true, data: lottery });
  })
);

/**
 * POST /api/lotteries/:id/participants
 * body: { code, fingerprint }
 * 参与抽奖，提交唯一编号和设备指纹。同一活动内一台设备只能参与一次。
 */
router.post(
  '/lotteries/:id/participants',
  asyncHandler(async (req, res) => {
    const { code, fingerprint } = req.body || {};
    const entry = await lotteryService.joinLottery(req.params.id, code, fingerprint);
    res.status(201).json({ ok: true, data: entry });
  })
);

/**
 * POST /api/lotteries/:id/draw
 * body: { extraDrawCount? }
 * 开奖：揭示密钥，计算并公开中奖名单。
 * extraDrawCount 为额外抽取人数，只会在原有中奖名单之后追加，不会影响原名单。
 * 已经开过奖的活动再次调用并传入更大的 extraDrawCount，即为追加抽取。
 */
router.post(
  '/lotteries/:id/draw',
  asyncHandler(async (req, res) => {
    const extraDrawCount = req.body ? req.body.extraDrawCount : undefined;
    const lottery = await lotteryService.drawLottery(req.params.id, extraDrawCount);
    res.json({ ok: true, data: lottery });
  })
);

module.exports = router;
