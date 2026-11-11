# WeRemember

保质期提醒 + 说明书库。家庭组共享，支持 Server酱（微信）和 QQ 邮件提醒。手机端 PWA，可添加到主屏幕。

- 保质期：录入护肤品 / 食品的生产日期与保质期，按「剩余时间占总保质期的比例」分阶段提醒，过期后每 3 天提醒一次。
- 说明书：上传 PDF / 图片，按产品名、分类、备注搜索，内嵌预览。
- 账号：邀请码注册，家庭组共享清单。

需求与设计见 `docs/requirements/WeRemember-v1.md`。

## 技术栈

Node.js + Express 4、SQLite（`better-sqlite3`）、前端原生 JS + Vite 6。

**运行与测试必须使用 Node 20**（`better-sqlite3` 按 Node 20 的 ABI 编译，Node 24 下会加载失败或崩溃）。

## 开发

```bash
npm install
ADMIN_INVITE_CODE=changeme npm run dev   # http://localhost:5176
npm test
npm run build
```

首个账号：用 `ADMIN_INVITE_CODE` 的值作为邀请码注册，该账号即管理员；之后由管理员在「设置」里生成注册邀请码（一次性，7 天有效）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | 端口，默认 5176 |
| `DATA_DIR` | 数据目录（数据库、上传文件、JWT 密钥），默认 `./data` |
| `ADMIN_INVITE_CODE` | 首个管理员的注册邀请码，仅在尚无管理员时生效 |
| `JWT_SECRET` | 可选；不设置则自动生成并保存在 `DATA_DIR/.jwt-secret` |
| `SMTP_USER` / `SMTP_PASS` | 发件 QQ 邮箱及授权码；不设置则邮件提醒不可用 |
| `SMTP_HOST` / `SMTP_PORT` | 可选，默认 `smtp.qq.com` / `465` |

## 目录

```
server/
  index.js          入口：装配 + 启动定时任务
  app.js            Express 应用（可注入依赖，便于测试）
  db.js             表结构
  routes/           auth / account / groups / items / manuals
  lib/
    reminder-rules.js   提醒规则（纯函数）
    dispatch.js         每日汇总生成与发送
    channels.js         Server酱 / 邮件
    scheduler.js        每分钟检查一次，到点发送
src/                前端源码，构建到 public/dist/
tests/              规则单测 + 接口集成测试
docs/requirements/  需求文档
```
