# 公平抽奖

一个可部署到宝塔、带网页和 REST API 的公平透明抽奖系统。

核心目标是：活动创建后固定承诺，报名截止后固定参与名单，开奖后公开全部输入；任何人拿到公开 JSON 后，都可以在本地重算出完全相同的中奖名单。

## 功能

- 创建抽奖，锁定标题、中奖人数、报名截止时间和初始承诺
- 参与者提交唯一编号
- 每次参与都会推进公开哈希链，并返回个人收据哈希
- 报名截止前不能开奖，截止后不能再参与
- 使用 `SHA-256`、无偏拒绝采样和 Fisher-Yates 确定性洗牌
- 推荐叠加 drand 公开随机数信标，开奖必须等到报名截止后的未来轮次产生
- 网页操作和 REST API
- `scripts/verify.js` 零依赖独立验证脚本，支持本地 JSON 和 API URL
- JSON 文件持久化，适合单机宝塔部署

## 公平模型

推荐创建活动时保持“叠加 drand”开启。

### 承诺-揭示

创建时服务器生成 32 字节随机密钥 `secret`，并公开：

```text
commitHash = SHA256(UTF-8 编码的 secret 十六进制字符串)
```

`secret` 在开奖前不会通过 API 返回，开奖时才公开。任何人可以检查 `SHA256(secret) == commitHash`，确认服务器没有在报名后更换密钥。

### 报名截止

`closeAt` 在创建时锁定，服务器以自己的系统时间判断截止。截止前拒绝开奖，截止后拒绝新参与者。最终种子不使用“点击开奖”的时间，因此不能通过反复选择开奖时刻来挑选结果。

### 参与者哈希链

初始种子：

```text
initialSeed = SHA256("INIT|" + commitHash + "|" + createdAt + "|" + extraEntropy)
```

未启用 drand 时 `extraEntropy` 为空；启用时为 `drand:<targetRound>`。

每位参与者按加入顺序计算：

```text
receipt = SHA256(JSON.stringify([previousHash, index, code, joinedAt]))
```

其中 `index` 从 `0` 开始。参与者编号 `code` 会先去除首尾空白，区分大小写，长度上限 100 个字符，并要求整场活动内唯一。

### 最终种子和洗牌

不开启 drand 时：

```text
finalSeed = SHA256("FINAL|" + commitHash + "|" + secret + "|" + chainHead + "|")
```

开启 drand 时，最后一段替换为公开的 drand `randomness`：

```text
finalSeed = SHA256("FINAL|" + commitHash + "|" + secret + "|" + chainHead + "|" + randomness)
```

服务器会锁定报名截止时间之后的 drand round。该 round 尚未产生时不能预测；开奖接口取不到该 round 时返回 `RANDOMNESS_NOT_READY`，不会偷偷降级开奖。

随机流和洗牌也完全固定：

1. 依次计算 `SHA256(seedBytes + counterBytes)`，其中 `seedBytes` 是 `finalSeed` 十六进制解码后的 32 字节，`counterBytes` 是 8 字节大端整数，计数器从 0 开始。
2. 对每个洗牌位置使用拒绝采样生成均匀的 `j`，范围为 `[0, i]`。
3. 从 `i = participantCount - 1` 递减到 `1` 执行 Fisher-Yates 交换。
4. 洗牌后的前 `winnerCount` 个编号就是中奖名单。

## 快速开始

需要 Node.js 16 或更高版本，生产环境建议 Node.js 20/22 LTS。

```bash
npm install
npm start
```

默认监听 `0.0.0.0:3000`，可通过环境变量修改：

```bash
PORT=3000 HOST=127.0.0.1 npm start
```

打开 `http://127.0.0.1:3000/`。

## API

所有 API 返回格式：

```json
{
  "ok": true,
  "data": {}
}
```

错误格式：

```json
{
  "ok": false,
  "error": "错误说明",
  "code": "ERROR_CODE"
}
```

### 创建抽奖

```http
POST /api/lotteries
Content-Type: application/json
```

请求：

```json
{
  "title": "春节福利抽奖",
  "winnerCount": 3,
  "closeAt": "2030-02-01T12:00:00.000Z",
  "useExternalRandomness": true
}
```

`useExternalRandomness` 省略时默认为 `true`；明确传 `false` 才使用离线兼容模式。

### 获取活动

```http
GET /api/lotteries/:id
```

开奖前公开活动元数据、`commitHash`、`initialSeed`、当前 `chainHead` 和参与者记录，但不公开 `secret`。

### 参与抽奖

```http
POST /api/lotteries/:id/participants
Content-Type: application/json
```

请求：

```json
{
  "code": "USER-0001"
}
```

成功响应中的 `receipt` 是该参与者的收据哈希，请参与者自行保存。

### 开奖

```http
POST /api/lotteries/:id/draw
```

只有报名截止后才能开奖。成功后公开 `secret`、`finalSeed`、完整 `shuffledOrder` 和 `winners`。

drand 还未产生时返回：

```json
{
  "ok": false,
  "error": "公开随机数信标尚未准备好或暂时无法访问，请稍后重试。",
  "code": "RANDOMNESS_NOT_READY"
}
```

### 活动列表和健康检查

```http
GET /api/lotteries
GET /health
```

## 本地验证

验证脚本不依赖 Express 或本项目源码，只使用 Node.js 内置 `crypto`：

```bash
node scripts/verify.js lottery-data.json
```

也可以直接验证线上 API：

```bash
node scripts/verify.js https://example.com/api/lotteries/活动ID
```

网页“查看/开奖”页面的“下载完整验证数据”按钮可以下载 JSON。

验证脚本会检查：

- `SHA256(secret)` 是否等于创建时的 `commitHash`
- `initialSeed` 是否正确
- 全部参与者哈希链和每一份收据
- drand 公开随机值是否已写入最终种子输入；联网时还会请求该 round 的 drand 官方公开接口做交叉比对
- `finalSeed`、完整洗牌顺序和中奖名单

## 宝塔部署

以下示例假设项目目录为 `/www/wwwroot/fair-lottery`。

### 1. 上传项目

将整个项目上传到服务器，至少包含：

```text
package.json
package-lock.json
src/
public/
scripts/
data/
ecosystem.config.cjs
```

在宝塔终端执行：

```bash
cd /www/wwwroot/fair-lottery
npm install --omit=dev
chmod 750 data
```

Node.js 版本请选择 20 或 22 LTS。`data` 目录必须可由运行 Node 的用户写入。

### 2. 用 PM2 启动

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

执行 `pm2 startup` 后，把它输出的那条命令再执行一次。查看日志：

```bash
pm2 logs fair-lottery
pm2 status
```

配置默认监听 `127.0.0.1:3000`，不要在公网直接暴露 3000 端口。

### 3. 宝塔反向代理

在宝塔“网站 -> 反向代理”中新增代理：

```text
目标 URL: http://127.0.0.1:3000
发送域名: $host
```

或者在 Nginx 配置中使用：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

然后在宝塔申请并开启 HTTPS。HTTPS 很重要，因为参与编号和活动数据会通过网络传输。

### 4. 验证部署

```bash
curl https://你的域名/health
```

应返回：

```json
{"ok":true}
```

### 5. 备份

每个活动存储为 `data/<活动ID>.json`。请定期备份整个 `data` 目录。该目录包含尚未开奖活动的内部 `secret_plain`，不能放进 Nginx 静态网站目录，也不能提交到公开 Git 仓库。

## 重要安全边界

- 项目默认是公开 API，没有用户登录和管理员权限；任何人都可以创建活动、参与活动，并在截止后触发开奖。这符合“公开触发、公开验证”的设计。若需要只有创建者能开奖，应在宝塔前置鉴权，或另行增加创建者 token。
- 推荐开启 drand。关闭 drand 的离线模式仍然能发现篡改并保证本地复现，但服务器运营者因为生成了 `secret`，可能在开奖前计算结果；它不提供对运营者的不可预测性。
- drand 模式不是“服务器绝对诚实”的替代品。服务器仍可能拒绝请求、删除文件或停止服务；哈希链能证明公开数据被改过，但不能证明服务器从未漏记一个没有保留收据的人。
- 参与编号会在开奖后的公开 JSON 中展示。不要直接填写完整手机号、身份证号等敏感信息，建议使用不含隐私的唯一编号。
- 文件存储只适合单个 Node 进程。PM2 必须使用 `instances: 1` 和 `fork`；不要启用 cluster 多实例，否则内存锁不能跨进程同步。
- 服务器系统时间应通过 NTP 同步。报名截止判定使用服务器时钟，并且 `closeAt` 创建后不可修改。

## 目录结构

```text
public/index.html       网页
public/app.js           网页交互和 API 调用
public/style.css        样式
src/lib/fairness.js     抽奖算法
src/lib/drand.js        drand 公开随机数接入
src/lib/store.js        原子 JSON 文件存储
src/services/           业务逻辑
src/routes/api.js        REST API
src/app.js              Express 应用
src/server.js           启动入口
scripts/verify.js       零依赖本地验证器
data/                   活动数据，不应公开静态访问
```
