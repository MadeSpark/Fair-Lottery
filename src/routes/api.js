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
 * GET /api/lotteries
 * 列出所有抽奖活动摘要。
 */
router.get(
  '/lotteries',
  asyncHandler(async (req, res) => {
    const items = await lotteryService.listLotteries();
    res.json({ ok: true, data: items });
  })
);

/**
 * GET /api/lotteries/:id
 * 获取某个抽奖活动的完整公开数据（用于展示和本地验证）。
 */
router.get(
  '/lotteries/:id',
  asyncHandler(async (req, res) => {
    const lottery = await lotteryService.getLottery(req.params.id);
    res.json({ ok: true, data: lottery });
  })
);

/**
 * POST /api/lotteries/:id/participants
 * body: { code }
 * 参与抽奖，提交唯一编号。
 */
router.post(
  '/lotteries/:id/participants',
  asyncHandler(async (req, res) => {
    const { code } = req.body || {};
    const entry = await lotteryService.joinLottery(req.params.id, code);
    res.status(201).json({ ok: true, data: entry });
  })
);

/**
 * POST /api/lotteries/:id/draw
 * 开奖：揭示密钥，计算并公开中奖名单。
 */
router.post(
  '/lotteries/:id/draw',
  asyncHandler(async (req, res) => {
    const lottery = await lotteryService.drawLottery(req.params.id);
    res.json({ ok: true, data: lottery });
  })
);

module.exports = router;
