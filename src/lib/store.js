/**
 * 简易文件存储层
 * ------------------------------------------------------------
 * 每个抽奖活动对应 data/&lt;id&gt;.json 一个文件，写入时先写临时文件再
 * rename，避免写一半崩溃导致文件损坏。同一进程内对同一文件的
 * 并发写入用内存队列串行化，避免竟态覆盖。
 *
 * 注意：本存储方案假定后端只跑单个 Node 进程（宝塔部署时建议用
 * pm2 以 instances=1 方式启动，不要开多实例集群，否则多个进程
 * 各自的内存锁不会互斥，可能出现写冲突）。如果未来需要多实例，
 * 请换成数据库 + 事务。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 每个 id 的写入队列，保证同一活动的写操作串行执行
const writeQueues = new Map();

function filePathFor(id) {
  // 防止路径穿越
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('非法的活动 ID');
  return path.join(DATA_DIR, `${safeId}.json`);
}

function readSync(id) {
  const fp = filePathFor(id);
  if (!fs.existsSync(fp)) return null;
  const raw = fs.readFileSync(fp, 'utf8');
  return JSON.parse(raw);
}

function writeSyncAtomic(id, data) {
  const fp = filePathFor(id);
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

/**
 * 以串行化方式对某个活动执行读改写操作。
 * mutator(data) 可以是同步或返回 Promise 的函数，
 * data 为 null 表示活动不存在（用于创建场景）。
 * 返回 mutator 的返回值。
 */
function withLottery(id, mutator) {
  const prev = writeQueues.get(id) || Promise.resolve();
  let result;
  const next = prev
    .catch(() => {}) // 前一个任务出错不应阻塞后续任务
    .then(async () => {
      const data = readSync(id);
      result = await mutator(data);
      if (result && result.__delete) {
        const fp = filePathFor(id);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } else if (result && result.__data) {
        writeSyncAtomic(id, result.__data);
      }
    });
  writeQueues.set(id, next);
  return next.then(() => (result && result.__return !== undefined ? result.__return : undefined));
}

function listIds() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

module.exports = {
  readSync,
  withLottery,
  listIds,
  filePathFor,
};
