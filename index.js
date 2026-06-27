const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const Tesseract = require('tesseract.js');

const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_INTERVAL = 60 * 60 * 1000; // 每小时备份一次
const START_TIME = Date.now();
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 令牌有效期：24小时

// ===== 账户管理 =====
// 默认账户（密码用 SHA256 哈希存储）
// admin = 下注账户（完整权限）/ finance = 财务账户（只读）
let accounts = {};

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    } else {
      accounts = {};
      resetDefaultAccounts();
    }
  } catch (e) {
    accounts = {};
    resetDefaultAccounts();
  }
}

function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function resetDefaultAccounts() {
  accounts = {};
  // 下注账户：admin / admin123
  addAccount('admin', 'admin123', 'admin', '下注账户');
  // 财务账户：finance / finance123
  addAccount('finance', 'finance123', 'finance', '财务账户');
  saveAccounts();
}

function addAccount(username, password, role, label) {
  accounts[username] = {
    password: hash(password),
    role,
    label,
    createdAt: Date.now()
  };
}

function hash(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ===== 令牌管理 =====
const tokens = {}; // token -> { username, role, label, expiresAt }

function createToken(username, account) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens[token] = {
    username,
    role: account.role,
    label: account.label,
    expiresAt: Date.now() + TOKEN_EXPIRY
  };
  // 定期清理过期令牌
  cleanTokens();
  return token;
}

function verifyToken(token) {
  if (!token || !tokens[token]) return null;
  if (Date.now() > tokens[token].expiresAt) {
    delete tokens[token];
    return null;
  }
  return tokens[token];
}

function cleanTokens() {
  const now = Date.now();
  for (const t in tokens) {
    if (tokens[t].expiresAt < now) delete tokens[t];
  }
}

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
loadAccounts(); // 加载账户

// ===== API =====

// 登录
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }

    const account = accounts[username];
    if (!account) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    if (account.password !== hash(String(password))) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = createToken(username, account);
    res.json({
      ok: true,
      token,
      username,
      role: account.role,
      label: account.label
    });
  } catch (e) {
    console.error('登录错误:', e.message);
    res.status(500).json({ error: '登录失败' });
  }
});

// 验证令牌
app.post('/api/verify', (req, res) => {
  try {
    const { token } = req.body || {};
    const session = verifyToken(token);
    if (!session) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    res.json({
      ok: true,
      username: session.username,
      role: session.role,
      label: session.label
    });
  } catch (e) {
    res.status(500).json({ error: '验证失败' });
  }
});

// 修改密码
app.post('/api/change-password', (req, res) => {
  try {
    const { token, oldPassword, newPassword } = req.body || {};
    const session = verifyToken(token);
    if (!session) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }

    const account = accounts[session.username];
    if (!account) {
      return res.status(404).json({ error: '账户不存在' });
    }

    if (account.password !== hash(String(oldPassword))) {
      return res.status(403).json({ error: '原密码错误' });
    }

    if (!newPassword || String(newPassword).length < 4) {
      return res.status(400).json({ error: '新密码至少4位' });
    }

    account.password = hash(String(newPassword));
    saveAccounts();
    res.json({ ok: true, message: '密码修改成功' });
  } catch (e) {
    res.status(500).json({ error: '修改失败' });
  }
});

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
// 需要登录 + admin 角色
app.put('/api/data', (req, res) => {
  try {
    // ===== 权限检查 =====
    const token = req.headers['x-auth-token'] || req.body?._token;
    const session = verifyToken(token);
    if (!session) {
      return res.status(401).json({ error: '请先登录' });
    }
    if (session.role !== 'admin') {
      return res.status(403).json({ error: '财务账户无权限修改数据' });
    }

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

// ===== 截图 OCR 识别赔率 =====
app.post('/api/ocr', (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) {
      return res.status(400).json({ error: '请提供图片数据' });
    }

    // 去掉 data:image/xxx;base64, 前缀
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');

    // 使用 tesseract 识别中英文
    Tesseract.recognize(buf, 'chi_sim+eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          console.log(`OCR 进度: ${Math.round(m.progress * 100)}%`);
        }
      }
    }).then(({ data: { text } }) => {
      console.log('OCR 原始结果:\n' + text);

      // 解析识别文本，提取赔率数据
      const parsed = parseOddsText(text);
      res.json({ ok: true, raw: text, parsed });
    }).catch(e => {
      console.error('OCR 错误:', e.message);
      res.status(500).json({ error: '图片识别失败: ' + e.message });
    });
  } catch (e) {
    console.error('OCR 请求错误:', e.message);
    res.status(500).json({ error: '处理失败: ' + e.message });
  }
});

// ===== 赔率文本解析 =====
function parseOddsText(text) {
  const result = {
    homeTeam: '',
    awayTeam: '',
    time: '',
    odds: {}  // { '1x2': {home, draw, away}, 'ah': {line, home, away}, 'ou': {line, over, under}, 'cs': [{score, odds}, ...] }
  };

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 尝试识别球队名称（通常在开头几行）
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i];
    // 匹配 "队名1 vs 队名2" 或 "队名1 V 队名2" 或 "队名1 队名2" 含比分
    const vsMatch = line.match(/(.+?)\s*[vV][sS]\s*(.+)/);
    if (vsMatch) {
      result.homeTeam = vsMatch[1].trim();
      result.awayTeam = vsMatch[2].trim().replace(/\d+$/, '').trim(); // 去掉末尾分数
      break;
    }
    // 匹配 "队名1 v 队名2"
    const vMatch = line.match(/(.+?)\s+[vV]\s+(.+)/);
    if (vMatch && !result.homeTeam) {
      result.homeTeam = vMatch[1].trim();
      result.awayTeam = vMatch[2].trim().split(/\d/)[0].trim();
    }
  }

  // 如果没找到 vs 格式，尝试用前两行中较长的行
  if (!result.homeTeam && lines.length >= 2) {
    const candidates = lines.slice(0, 4).filter(l => l.length > 3 && !/^\d/.test(l) && !/赔率|盘口|odds/i.test(l));
    if (candidates.length >= 2) {
      result.homeTeam = candidates[0];
      result.awayTeam = candidates[1].split(/\d/)[0].trim();
    }
  }

  // 识别时间（格式: MM-DD HH:mm 或 YYYY-MM-DD HH:mm）
  for (const line of lines) {
    const timeMatch = line.match(/(\d{1,2}[-\/]\d{1,2}\s+\d{1,2}:\d{2})/);
    if (timeMatch) {
      result.time = timeMatch[1];
      break;
    }
  }

  // 识别欧赔 1x2 (主胜/平/客胜)
  for (const line of lines) {
    // 格式: 1.80 3.50 4.20 或 1.80 / 3.50 / 4.20
    const oddsMatch = line.match(/(\d+\.\d{2})\s*[\/\s]\s*(\d+\.\d{2})\s*[\/\s]\s*(\d+\.\d{2})/);
    if (oddsMatch) {
      const h = parseFloat(oddsMatch[1]);
      const d = parseFloat(oddsMatch[2]);
      const a = parseFloat(oddsMatch[3]);
      // 验证合理性: 通常在 1.01 ~ 999 之间
      if (h > 1 && h < 100 && d > 1 && d < 100 && a > 1 && a < 100) {
        result.odds['1x2'] = { home: h, draw: d, away: a };
        break;
      }
    }
  }

  // 识别亚盘 handicap
  for (const line of lines) {
    // 格式: -0.5 0.90 0.95 或 0.5 1.05 0.85
    const ahMatch = line.match(/([-+]?\d+\.?\d*)\s+(\d+\.\d{2})\s+(\d+\.\d{2})/);
    if (ahMatch) {
      const line_val = parseFloat(ahMatch[1]);
      const home_odds = parseFloat(ahMatch[2]);
      const away_odds = parseFloat(ahMatch[3]);
      if (Math.abs(line_val) <= 5 && home_odds > 0.5 && away_odds > 0.5) {
        result.odds.ah = { line: line_val, home: home_odds, away: away_odds };
        break;
      }
    }
  }

  // 识别大小球
  for (const line of lines) {
    const ouMatch = line.match(/(\d+\.?\d*)\s+[大小]\s+(\d+\.\d{2})\s+(\d+\.\d{2})/);
    if (ouMatch) {
      result.odds.ou = { line: parseFloat(ouMatch[1]), over: parseFloat(ouMatch[2]), under: parseFloat(ouMatch[3]) };
      break;
    }
  }
  // 英文大小球: O/U 2.5 0.90 0.95
  if (!result.odds.ou) {
    for (const line of lines) {
      const ouMatch2 = line.match(/[Oo]\s*[\/]\s*[Uu]\s*(\d+\.?\d*)\s+(\d+\.\d{2})\s+(\d+\.\d{2})/);
      if (ouMatch2) {
        result.odds.ou = { line: parseFloat(ouMatch2[1]), over: parseFloat(ouMatch2[2]), under: parseFloat(ouMatch2[3]) };
        break;
      }
    }
  }

  // 识别波胆/正确比分赔率 (格式: 1-0 8.00, 2-1 9.50, 其他 15.00)
  const csList = [];
  for (const line of lines) {
    // 匹配: "1-0 8.00", "2-1 9.50", "0-0 12.00" 等
    const csMatch = line.match(/(\d+\s*[-:]\s*\d+)\s+(\d+\.?\d{0,2})/);
    if (csMatch) {
      const score = csMatch[1].replace(/\s+/g, '');
      const oddsVal = parseFloat(csMatch[2]);
      if (oddsVal > 1 && oddsVal < 999) {
        csList.push({ score, odds: oddsVal });
      }
    }
    // 匹配 "其他 15.00"
    const otherMatch = line.match(/其他\s+(\d+\.?\d{0,2})/);
    if (otherMatch) {
      const oddsVal = parseFloat(otherMatch[1]);
      if (oddsVal > 1 && oddsVal < 999) {
        csList.push({ score: '其他', odds: oddsVal });
      }
    }
  }
  if (csList.length >= 3) {
    // 去重（按 score）
    const seen = new Set();
    result.odds.cs = csList.filter(x => {
      if (seen.has(x.score)) return false;
      seen.add(x.score);
      return true;
    });
  }

  console.log('解析结果:', JSON.stringify(result, null, 2));
  return result;
}

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
