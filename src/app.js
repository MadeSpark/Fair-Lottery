const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const apiRouter = require('./routes/api');
const { LotteryError } = require('./services/lotteryService');

const app = express();

app.disable('x-powered-by');
app.use(helmet());
// 开放 API 给任意来源的第三方程序调用；如需限制来源，把 origin 改成白名单数组。
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '256kb' }));

// 基础限流，防止参与接口被刷。可通过环境变量调整。
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '请求过于频繁，请稍后再试' },
});
app.use('/api', apiLimiter);
app.use('/api', apiRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

// 404
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ ok: false, error: '接口不存在' });
  }
  next();
});

// 统一错误处理
app.use((err, req, res, next) => {
  if (err instanceof LotteryError) {
    return res.status(err.status).json({ ok: false, error: err.message, code: err.code });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

module.exports = app;
