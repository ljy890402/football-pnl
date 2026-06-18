# ⚽ 足球注单盈亏分析 — 云服务器版

完整的「一人多设备同步 + 多人共享数据」方案。

---

## 🚀 快速开始（本地运行）

```bash
cd server
npm install
npm start
```

打开 `http://localhost:3000` 即可使用。

---

## ☁️ 云端部署（三选一）

### 方案一：Render.com（免费 · 一键部署 ✅ 推荐）

**只需把 `server/` 目录推送到 GitHub，其余自动完成。**

1. 在 GitHub 创建仓库，把整个项目（含 `server/`）推送上去
2. 访问 [render.com](https://render.com)，用 GitHub 登录
3. 点击 **New + → Web Service**
4. 连接你的 GitHub 仓库
5. Render 会自动读取根目录的 `render.yaml`，**无需手动配置**
6. 点击 **Create Web Service**，等待 2-3 分钟
7. 获得地址：`https://football-pnl.onrender.com`
8. 手机 Safari 打开 → **分享 → 添加到主屏幕** = iPhone App

> **免费套餐注意**：15 分钟无访问会休眠，下次首次访问需等待约 30 秒启动。

---

### 方案二：自建 VPS（最稳定 · 推荐生产使用）

```bash
# 1. SSH 登录你的 VPS，上传 server/ 目录
scp -r server/ user@your-vps:/home/user/football-pnl

# 2. 安装依赖
cd /home/user/football-pnl/server
npm install

# 3. 用 pm2 后台运行（崩溃自动重启）
npm install -g pm2
pm2 start index.js --name football-pnl
pm2 save
pm2 startup    # 开机自启

# 4. Nginx 反向代理 + HTTPS（建议）
sudo apt install nginx certbot python3-certbot-nginx

# Nginx 配置示例 (/etc/nginx/sites-available/football-pnl)
cat > /tmp/football-nginx << 'EOF'
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/football-pnl /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 5. 启用 HTTPS
sudo certbot --nginx -d your-domain.com
```

---

### 方案三：Railway.app（另类免费方案）

1. [railway.app](https://railway.app) 注册
2. New Project → Deploy from GitHub repo
3. 选择仓库，Railway 自动检测 Node 项目
4. 设置 Root Directory 为 `server/`
5. 部署完成后获得公网地址

---

## 📊 数据架构

```
┌──────────────────────────────────────────┐
│  iPhone A / 电脑 B / iPad C / ...        │
│  ┌────────────────────────────────────┐  │
│  │  localStorage（本地缓存）           │  │
│  │  ↓ 500ms 防抖写入                   │  │
│  │  PUT /api/data（含 _version 乐观锁）│  │
│  └────────────────────────────────────┘  │
│           │  ↑（每 15s 轮询检查更新）     │
└───────────┼──┼───────────────────────────┘
            │  │
┌───────────┴──┴───────────────────────────┐
│  Express 服务器                           │
│  ┌────────────────────────────────────┐  │
│  │ GET  /api/health  → 健康检查       │  │
│  │ GET  /api/data    → 获取全部数据    │  │
│  │ PUT  /api/data    → 保存（含版本锁）│  │
│  │ GET  /api/ping    → 轻量更新检查    │  │
│  │ GET  /api/backups → 备份列表        │  │
│  │ POST /api/restore → 数据恢复        │  │
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │ data.json（单文件存储）             │  │
│  │ backups/data-*.json（每小时自动备份）│  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

---

## 🔄 同步机制详解

| 步骤 | 触发方式 | 说明 |
|------|---------|------|
| ① 本地操作 | 用户点击/输入 | 修改 `S.ms` / `S.cl` / `S.bl` |
| ② 本地缓存 | 立即 | `localStorage.setItem('fpnl3', ...)` |
| ③ 云推送 | 500ms 防抖 | `PUT /api/data`，携带 `_version` 乐观锁 |
| ④ 冲突检测 | 服务端 | 版本不匹配 → 409 冲突，客户端自动合并重试 |
| ⑤ 轮询检查 | 每 15 秒 | `GET /api/ping`，比较 `_version` |
| ⑥ 拉取最新 | 有更新时 | `GET /api/data`，覆盖本地状态并刷新界面 |
| ⑦ 离线恢复 | 网络恢复时 | 自动从 localStorage 恢复，连接后同步 |

### 冲突处理策略

- **乐观锁**：每次 PUT 携带当前 `_version`，服务端比对
- **版本不匹配** → 409 + 自动合并（服务器数据覆盖本地）
- **最多重试 3 次**，仍失败则提示用户刷新

### 状态指示灯（侧边栏底部）

| 颜色 | 状态 | 含义 |
|------|------|------|
| 🟢 绿 | 已同步 | 数据与服务器一致 |
| 🟡 黄 | 同步中... | 正在上传或下载 |
| ⚫ 灰 | 离线模式 | 无网络连接，使用本地缓存 |
| 🔴 红（闪烁） | 冲突 | 数据冲突无法自动解决 |

---

## 🔒 安全建议

**生产环境使用前，务必修改以下配置：**

1. **管理员密码**（用于数据恢复）
   ```bash
   # 设置环境变量
   export ADMIN_KEY="你的复杂密码"
   ```

2. **Nginx 加 Basic Auth**（如需要访问控制）
   ```nginx
   location / {
       auth_basic "Football PNL";
       auth_basic_user_file /etc/nginx/.htpasswd;
       proxy_pass http://127.0.0.1:3000;
   }
   # 生成密码文件: htpasswd -c /etc/nginx/.htpasswd username
   ```

3. **防火墙**（VPS 必做）
   ```bash
   sudo ufw allow 22    # SSH
   sudo ufw allow 80    # HTTP
   sudo ufw allow 443   # HTTPS
   sudo ufw enable
   ```

---

## 💾 备份与恢复

### 自动备份

服务器每小时自动备份 `data.json` 到 `backups/` 目录，保留最近 48 个（2 天）。

备份文件名格式：`data-2026-06-18T17-00-00.json`

### 手动恢复

```bash
# 查看可用备份
curl http://your-server:3000/api/backups

# 从备份恢复（需要管理员密码）
curl -X POST http://your-server:3000/api/restore \
  -H "Content-Type: application/json" \
  -d '{"backup":"data-2026-06-18T17-00-00.json","adminKey":"football-admin-2026"}'
```

恢复前会自动创建当前数据的快照，防止误操作。

### 定期异地备份（建议）

```bash
# VPS 上添加 crontab（每天凌晨 3 点备份到其他位置）
0 3 * * * cp /path/to/server/data.json /backup/location/football-$(date +\%Y\%m\%d).json
```

---

## 📱 PWA 安装（添加到主屏幕）

1. iPhone Safari 打开服务器地址
2. 点击底部 **分享按钮**（方框+箭头）
3. 滑动找到 **「添加到主屏幕」**
4. 点击 **「添加」**
5. 桌面出现 ⚽ 图标，点击即可全屏使用

支持离线使用（Service Worker 缓存），网络恢复后自动同步。

---

## 🛠 技术栈

- **后端**：Node.js + Express
- **存储**：JSON 文件（原子写入：tmp → rename）
- **同步**：乐观锁版本号 + 15s 轮询
- **前端**：原生 HTML/CSS/JS（零依赖 SPA）
- **PWA**：Service Worker + Manifest + Apple Touch Icon
- **部署**：Render.com / Railway / 自建 VPS
