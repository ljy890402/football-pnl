const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_INTERVAL = 60 * 60 * 1000; // 每小时备份一次
const START_TIME = Date.now();

// ===== 中间件 =====
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// 静态文件（缓存策略：1小时）
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // HTML 不缓存（确保获取最新版本）
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ===== 数据读写 =====

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    // 确保数据结构完整
    if (!Array.isArray(data.ms)) data.ms = [];
    if (!Array.isArray(data.cs)) data.cs = [];
    if (!data.bl || typeof data.bl !== 'object') data.bl = {};
    if (!data._version) data._version = 0;
    if (!data.lastModified) data.lastModified = 0;
    return data;
  } catch (e) {
    return { ms: [], cs: [], bl: {}, _version: 0, lastModified: 0 };
  }
}

function writeData(data) {
  // 确保关键字段类型正确
  if (!Array.isArray(data.ms)) data.ms = [];
  if (!Array.isArray(data.cs)) data.cs = [];
  if (!data.bl || typeof data.bl !== 'object') data.bl = {};

  data._version = (data._version || 0) + 1;
  data.lastModified = Date.now();

  // 原子写入：先写临时文件，再重命名
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);

  return { version: data._version, lastModified: data.lastModified };
}

// 启动时确保数据文件存在
if (!fs.existsSync(DATA_FILE)) {
  writeData({ ms: [], cs: [], bl: {} });
  console.log('✓ 创建初始数据文件');
}

// ===== 自动备份 =====

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function createBackup() {
  try {
    ensureBackupDir();
    const data = readData();
    const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(BACKUP_DIR, `data-${date}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(data, null, 2));

    // 只保留最近 48 个备份（2天）
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('data-') && f.endsWith('.json'))
      .sort();
    while (files.length > 48) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
  } catch (e) {
    console.error('备份失败:', e.message);
  }
}

setInterval(createBackup, BACKUP_INTERVAL);
createBackup(); // 启动时立即备份一次

// ===== API =====

// 健康检查
app.get('/api/health', (req, res) => {
  const data = readData();
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    version: data._version || 0,
    matchCount: (data.ms || []).length,
    clientCount: (data.cs || []).length,
    lastModified: data.lastModified || 0
  });
});

// 获取全部数据
app.get('/api/data', (req, res) => {
  try {
    const data = readData();
    res.json({
      ms: data.ms,
      cs: data.cs,
      bl: data.bl,
      _version: data._version,
      lastModified: data.lastModified
    });
  } catch (e) {
    console.error('GET /api/data 错误:', e.message);
    res.status(500).json({ error: '读取数据失败' });
  }
});

// 保存全部数据（带版本检查，防并发冲突）
app.put('/api/data', (req, res) => {
  try {
    const incoming = req.body;

    // 基本格式验证
    if (!incoming || !Array.isArray(incoming.ms)) {
      return res.status(400).json({ error: '数据格式不正确：缺少 ms 数组' });
    }

    // 乐观锁：如果客户端传了 _version，检查是否匹配
    const current = readData();
    if (incoming._version !== undefined && current._version !== incoming._version) {
      // 版本冲突：返回服务器最新版本，让客户端合并
      return res.status(409).json({
        error: '数据已被其他设备修改，请刷新后重试',
        conflict: true,
        serverVersion: current._version,
        serverData: {
          ms: current.ms,
          cs: current.cs,
          bl: current.bl,
          _version: current._version,
          lastModified: current.lastModified
        }
      });
    }

    // 写入数据
    const result = writeData({
      ms: incoming.ms,
      cs: incoming.cs || [],
      bl: incoming.bl || {},
      _version: current._version // 基于当前版本递增
    });

    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('PUT /api/data 错误:', e.message);
    res.status(500).json({ error: '保存数据失败' });
  }
});

// 检查是否有更新（轻量接口，只返回时间戳和版本号）
app.get('/api/ping', (req, res) => {
  try {
    const data = readData();
    res.json({
      lastModified: data.lastModified || 0,
      _version: data._version || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 列出备份
app.get('/api/backups', (req, res) => {
  try {
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('data-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 20) // 最多返回最近20个
      .map(f => ({
        name: f,
        time: f.replace('data-', '').replace('.json', '').replace(/-/g, ':'),
        size: fs.statSync(path.join(BACKUP_DIR, f)).size
      }));
    res.json({ backups: files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 从备份恢复（需要管理员密码）
app.post('/api/restore', (req, res) => {
  try {
    const { backup, adminKey } = req.body;
    const ADMIN_KEY = process.env.ADMIN_KEY || 'football-admin-2026';

    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ error: '管理员密码错误' });
    }

    if (!backup) {
      return res.status(400).json({ error: '请指定要恢复的备份文件名' });
    }

    const backupFile = path.join(BACKUP_DIR, backup);
    if (!fs.existsSync(backupFile)) {
      return res.status(404).json({ error: '备份文件不存在' });
    }

    // 先创建当前数据的快照
    ensureBackupDir();
    const beforeRestore = readData();
    const snapshotFile = path.join(BACKUP_DIR, `before-restore-${Date.now()}.json`);
    fs.writeFileSync(snapshotFile, JSON.stringify(beforeRestore, null, 2));

    // 恢复
    const restoredData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    const result = writeData({
      ms: restoredData.ms || [],
      cs: restoredData.cs || [],
      bl: restoredData.bl || {},
      _version: beforeRestore._version
    });

    console.log(`⚠ 从备份恢复: ${backup}`);
    res.json({ ok: true, ...result, snapshot: path.basename(snapshotFile) });
  } catch (e) {
    console.error('恢复失败:', e.message);
    res.status(500).json({ error: '恢复失败: ' + e.message });
  }
});

// 前端路由回退（SPA 支持）
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== 优雅退出 =====
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('⚽  足球注单盈亏分析 - 云服务器');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  地址:    http://localhost:${PORT}`);
  console.log(`  数据:    ${DATA_FILE}`);
  console.log(`  备份:    ${BACKUP_DIR}`);
  console.log(`  间隔:    ${BACKUP_INTERVAL / 60000}分钟自动备份`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
});

process.on('SIGTERM', () => {
  console.log('\n收到 SIGTERM，正在保存数据...');
  createBackup();
  server.close(() => {
    console.log('服务器已安全关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n收到 SIGINT，正在保存数据...');
  createBackup();
  server.close(() => {
    console.log('服务器已安全关闭');
    process.exit(0);
  });
});
