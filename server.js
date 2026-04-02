require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const https = require('https');
const multer = require('multer');
const XLSX = require('xlsx');

const GameLink = require('./models/GameLink');
const ImportedOrder = require('./models/ImportedOrder');

const app = express();
const trustProxyRaw = String(process.env.TRUST_PROXY || '1').toLowerCase().trim();
const trustProxySetting = /^\d+$/.test(trustProxyRaw)
  ? Number(trustProxyRaw) // recommended for express-rate-limit (e.g. 1 hop nginx)
  : (['true', 'yes', 'on'].includes(trustProxyRaw) ? true : false);
app.set('trust proxy', trustProxySetting);
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: false  // Отключаем CSP (разрешаем inline-скрипты)
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const rateLimit = require('express-rate-limit');

// ═══════ Rate limiters ═══════
const steamCheckLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 10, // 10 запросов
  message: { ok: false, error: 'Слишком много попыток. Подождите минуту.' }
});

const paymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 минут
  max: 5,
  message: { ok: false, error: 'Слишком много запросов. Подождите 5 минут.' }
});

// ═══════ In-memory rate limiting для /api/link/:code ═══════
const linkAttempts = new Map();
setInterval(() => linkAttempts.clear(), 60000); // Очистка каждую минуту

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// ═══════ Утилита: запрос к Steam API ═══════
function steamApiRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ═══════ Парсинг Steam ID из URL ═══════
function extractSteamInfo(url) {
  const idMatch = url.match(/steamcommunity\.com\/id\/([^\/\?]+)/);
  const profileMatch = url.match(/steamcommunity\.com\/profiles\/(\d+)/);
  if (profileMatch) return { type: 'steamid64', value: profileMatch[1] };
  if (idMatch) return { type: 'vanity', value: idMatch[1] };
  return null;
}

// ═══════ API: Проверка Steam профиля ═══════
app.post('/api/check-steam', steamCheckLimiter, async (req, res) => {
  try {
    const { steamUrl } = req.body;
    if (!steamUrl) return res.json({ ok: false, error: 'Укажите ссылку на профиль Steam' });

    const steamInfo = extractSteamInfo(steamUrl);
    if (!steamInfo) return res.json({ ok: false, error: 'Неверный формат ссылки. Используйте: steamcommunity.com/id/... или steamcommunity.com/profiles/...' });

    const STEAM_KEY = process.env.STEAM_API_KEY;
    if (!STEAM_KEY) return res.json({ ok: false, error: 'Steam API ключ не настроен' });

    let steamId64 = null;

    if (steamInfo.type === 'vanity') {
      const vanityData = await steamApiRequest(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${steamInfo.value}`);
      if (vanityData.response?.success !== 1) return res.json({ ok: false, error: 'Профиль Steam не найден. Проверьте ссылку.' });
      steamId64 = vanityData.response.steamid;
    } else {
      steamId64 = steamInfo.value;
    }

    const profileData = await steamApiRequest(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${steamId64}`);
    const player = profileData.response?.players?.[0];
    if (!player) return res.json({ ok: false, error: 'Профиль Steam не найден' });

    if (player.communityvisibilitystate !== 3) {
      return res.json({
        ok: false,
        error: 'Профиль закрыт! Откройте его: Редактировать профиль → Приватность → Мой профиль → Открытый',
        profileClosed: true
      });
    }

    const gamesData = await steamApiRequest(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${steamId64}&include_played_free_games=1`);
    const gamesVisible = gamesData.response && (gamesData.response.game_count !== undefined);

    if (!gamesVisible) {
      return res.json({
        ok: false,
        error: 'Раздел с играми закрыт! Откройте: Редактировать профиль → Приватность → Доступ к игровой информации → Открытый',
        gamesClosed: true,
        steamId: steamId64,
        steamName: player.personaname,
        steamAvatar: player.avatarfull
      });
    }

    const ownedAppIds = [];
    if (gamesData.response?.games) {
      gamesData.response.games.forEach(g => ownedAppIds.push(String(g.appid)));
    }

    res.json({
      ok: true,
      steamId: steamId64,
      steamName: player.personaname,
      steamAvatar: player.avatarfull,
      profileOpen: true,
      gamesOpen: true,
      gamesCount: ownedAppIds.length,
      ownedAppIds
    });

  } catch (e) {
  console.error('Steam check error:', e.message);
  const errorMsg = process.env.NODE_ENV === 'production'
    ? 'Ошибка проверки Steam. Попробуйте позже.'
    : e.message;
  res.json({ ok: false, error: errorMsg });
}
});

// ═══════ Страница рулетки ═══════
app.get('/g/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'spin.html'));
});
// Backward compatibility for old marketplace links
app.get('/games/g/:code', (req, res) => {
  res.redirect(302, `/g/${req.params.code}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});

function normalizePathPrefix(prefix) {
  if (!prefix) return '';
  let normalized = String(prefix).trim();
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized === '/' ? '' : normalized;
}

function getPublicPathPrefix(req) {
  const envPrefix = normalizePathPrefix(process.env.PUBLIC_PATH_PREFIX);
  if (envPrefix) return envPrefix;
  if (req.originalUrl.startsWith('/games/')) return '/games';
  return '';
}

function getPublicBaseUrl(req) {
  const hostBase = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${hostBase}${getPublicPathPrefix(req)}`;
}

function adminAuth(req, res, next) {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return next();
  const provided = req.headers['x-admin-token'];
  if (provided !== token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}
app.use('/api/admin', adminAuth);

// ═══════ API: Проверка ссылки ═══════
app.get('/api/link/:code', async (req, res) => {
  try {
    // ═══════ Rate limiting (20 попыток в минуту с одного IP) ═══════
    const ip = req.ip || req.connection.remoteAddress;
    const attempts = (linkAttempts.get(ip) || 0) + 1;
    linkAttempts.set(ip, attempts);

    if (attempts > 20) {
      return res.status(429).json({ valid: false, error: 'Слишком много попыток. Подождите минуту.' });
    }
    // ══════════════════════════════════════════════════════════

    const link = await GameLink.findOne({ code: req.params.code });
    if (!link) return res.json({ valid: false, error: 'Ссылка не найдена' });
    if (!link.active) return res.json({ valid: false, error: 'Ссылка деактивирована' });

    if (link.spinCompleted) {
      if (link.keyAssigned) {
        return res.json({
          valid: true,
          spinCompleted: true,
          keyAssigned: true,
          keyRevealed: link.keyRevealed,
          gameName: link.gameName,
          gameKey: link.keyRevealed ? link.gameKey : null,
          steamAppId: link.steamAppId,
          tier: link.tier,
          country: link.country,
          boosted: link.boosted,
          boostPaid: link.boostPaid,
          excludeDuplicates: link.excludeDuplicates,
          steamProfileUrl: link.steamProfileUrl,
          steamId: link.steamId,
          steamName: link.steamName,
          steamAvatar: link.steamAvatar,
          respinCount: link.respinCount,
          respinRequested: link.respinRequested,
          respinType: link.respinType,
          oldKeyNeedsPickup: link.oldKeyNeedsPickup
        });
      } else {
        return res.json({
          valid: true,
          spinCompleted: true,
          keyAssigned: false,
          tier: link.tier,
          country: link.country,
          boosted: link.boosted,
          boostPaid: link.boostPaid,
          excludeDuplicates: link.excludeDuplicates,
          steamProfileUrl: link.steamProfileUrl,
          steamId: link.steamId,
          steamName: link.steamName,
          steamAvatar: link.steamAvatar,
          respinRequested: link.respinRequested,
          respinType: link.respinType,
          respinCount: link.respinCount,
          oldKeyNeedsPickup: link.oldKeyNeedsPickup
        });
      }
    }

    res.json({
      valid: true,
      spinCompleted: false,
      tier: link.tier,
      country: link.country,
      boosted: link.boosted || false,
      boostPaid: link.boostPaid || false,
      excludeDuplicates: link.excludeDuplicates || false,
      respinRequested: link.respinRequested,
      respinType: link.respinType,
      respinCount: link.respinCount,
      steamProfileUrl: link.steamProfileUrl,
      steamId: link.steamId,
      steamName: link.steamName,
      steamAvatar: link.steamAvatar
    });
  } catch (e) {
    res.status(500).json({ valid: false, error: 'Ошибка сервера' });
  }
});

// ═══════ API: Прокрутка рулетки ═══════
app.post('/api/spin', async (req, res) => {
  try {
    const { code, steamProfileUrl, steamId, steamName, steamAvatar, country, excludeDuplicates, boosted } = req.body;

    const link = await GameLink.findOne({ code });
    if (!link || !link.active) return res.json({ ok: false, error: 'Недействительная ссылка' });

    if (link.spinCompleted) {
      return res.json({
        ok: true,
        alreadySpun: true,
        keyAssigned: link.keyAssigned,
        keyRevealed: link.keyRevealed,
        gameName: link.gameName,
        gameKey: link.keyRevealed ? link.gameKey : null,
        steamAppId: link.steamAppId
      });
    }

    link.spinCompleted = true;
    link.excludeDuplicates = excludeDuplicates || false;
    if (boosted === true && !link.boosted) {
      link.boosted = true;
      link.boostPaid = true;
      if (!link.boostAmount) link.boostAmount = TIER_PRICES[link.tier]?.boost || 0;
    }
    link.steamProfileUrl = steamProfileUrl || null;
    link.steamId = steamId || null;
    link.steamName = steamName || null;
    link.steamAvatar = steamAvatar || null;
    link.country = country || null;
    await link.save();

    res.json({ ok: true, alreadySpun: false, keyAssigned: false });
  } catch (e) {
    console.error('Spin error:', e);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

// ═══════ ADMIN: Генерация ссылок ═══════
app.post('/api/admin/generate-links', async (req, res) => {
  try {
    const { count, tier, note } = req.body;
    const hasCount = count !== undefined && count !== null && String(count).trim() !== '';
    const parsedCount = Number.isInteger(count) ? count : Number.parseInt(count, 10);
    const normalizedCount = hasCount ? parsedCount : 1;

    if (!tier || !['starter', 'bronze', 'silver', 'gold', 'diamond'].includes(tier)) {
      return res.json({ ok: false, error: 'Укажите корректный tier' });
    }
    if (!Number.isFinite(normalizedCount) || normalizedCount < 1 || normalizedCount > 500) {
      return res.json({ ok: false, error: 'count должен быть числом от 1 до 500' });
    }

    const links = [];
    for (let i = 0; i < normalizedCount; i++) {
      const code = crypto.randomBytes(18).toString('base64url');
      try {
        const link = new GameLink({ code, tier, note: note || '' });
        await link.save();
        links.push({ code, tier, url: `${getPublicBaseUrl(req)}/g/${code}` });
      } catch (e) {
        if (e.code === 11000) { // Duplicate key (коллизия, 1 на миллиард)
          i--; // Повторить итерацию
          continue;
        }
        throw e;
      }
    }

    res.json({ ok: true, links });
  } catch (e) {
    console.error('Generate links error:', e);
    res.status(500).json({ ok: false, error: 'Ошибка генерации ссылок' });
  }
});

// ═══════ ADMIN: Назначить ключ ═══════
app.post('/api/admin/assign-key', async (req, res) => {
  const { code, gameName, gameKey, steamAppId, customerName, orderNumber } = req.body;

  const link = await GameLink.findOne({ code });
  if (!link) return res.json({ ok: false, error: 'Ссылка не найдена' });

  link.keyAssigned = true;
  link.gameName = gameName;
  link.gameKey = gameKey;
  link.steamAppId = steamAppId || null;
  link.customerName = customerName || null;
  link.orderNumber = orderNumber || null;
  link.respinRequested = false;
  link.respinPaid = false;
  link.respinType = null;
  link.respinOverlayDismissed = false;
  link.oldGameKey = null;
  link.oldKeyWarningShown = false;
  link.oldKeyNeedsPickup = false;
  link.previousGameName = null;
  link.previousGameKey = null;
  link.previousSteamAppId = null;
  link.keyRevealed = false;
  await link.save();

  res.json({ ok: true });
});

// ═══════ ADMIN: Список ссылок (с полной информацией) ═══════
app.get('/api/admin/links', async (req, res) => {
  const links = await GameLink.find().sort({ createdAt: -1 }).lean();

  const waiting = links.filter(l => l.respinRequested || (l.spinCompleted && !l.keyAssigned));
  const completed = links.filter(l => l.keyAssigned && !l.respinRequested);
  const unused = links.filter(l => !l.spinCompleted);

  const stats = {
    total: links.length,
    waiting: waiting.length,
    completed: completed.length,
    unused: unused.length,
    byTier: {
      starter: links.filter(l => l.tier === 'starter' && !l.spinCompleted).length,
      bronze: links.filter(l => l.tier === 'bronze' && !l.spinCompleted).length,
      silver: links.filter(l => l.tier === 'silver' && !l.spinCompleted).length,
      gold: links.filter(l => l.tier === 'gold' && !l.spinCompleted).length,
      diamond: links.filter(l => l.tier === 'diamond' && !l.spinCompleted).length
    }
  };

  res.json({ ok: true, links, stats });
});

// ═══════ ADMIN: Удалить ссылку ═══════
app.delete('/api/admin/link/:code', async (req, res) => {
  await GameLink.deleteOne({ code: req.params.code });
  res.json({ ok: true });
});

// ═══════ ADMIN: Скрыть оверлей респина ═══════
app.post('/api/admin/dismiss-respin-overlay', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ ok: false, error: 'Code required' });
  await GameLink.updateOne({ code }, { $set: { respinOverlayDismissed: true } });
  res.json({ ok: true });
});

// ═══════ ADMIN: Поиск по имени (GameLink + ImportedOrder) ═══════
app.get('/api/admin/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ ok: true, results: [] });
    if (q.length > 100) return res.json({ ok: false, error: 'Запрос слишком длинный' });

    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const gameLinks = await GameLink.find({
      $or: [
        { customerName: regex },
        { steamName: regex },
        { steamId: regex },
        { orderNumber: regex },
        { gameName: regex }
      ]
    }).sort({ createdAt: -1 }).lean();

    const imported = await ImportedOrder.find({
      $or: [
        { customerName: regex },
        { gameName: regex },
        { orderNumber: regex }
      ]
    }).sort({ createdAt: -1 }).lean();

    const results = [
      ...gameLinks.map(l => ({
        source: 'system',
        orderNumber: l.orderNumber || l.code,
        customerName: l.customerName,
        gameName: l.gameName,
        gameKey: l.gameKey,
        tier: l.tier,
        steamId: l.steamId,
        steamName: l.steamName,
        steamAvatar: l.steamAvatar,
        boosted: l.boosted,
        respinCount: l.respinCount,
        createdAt: l.createdAt
      })),
      ...imported.map(i => ({
        source: 'imported',
        orderNumber: i.orderNumber,
        customerName: i.customerName,
        gameName: i.gameName,
        gameKey: i.gameKey,
        tier: null,
        steamId: null,
        steamName: null,
        steamAvatar: null,
        boosted: false,
        respinCount: 0,
        createdAt: i.createdAt
      }))
    ];

    res.json({ ok: true, results });
  } catch (e) {
    console.error('Search error:', e);
    res.status(500).json({ ok: false, error: 'Ошибка поиска' });
  }
});

// ═══════ ADMIN: Импорт Excel ═══════
app.post('/api/admin/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'Файл не загружен' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (!rows.length) return res.json({ ok: false, error: 'Файл пустой' });

    const preview = rows.slice(0, 10).map(row => ({
      gameName: row['ИГРА'] || row['gameName'] || row['Game'] || '',
      gameKey: row['КЛЮЧ'] || row['gameKey'] || row['Key'] || '',
      orderNumber: row['НОМЕР ЗАКАЗА'] || row['orderNumber'] || row['Order'] || '',
      customerName: row['ФИО'] || row['customerName'] || row['Name'] || ''
    }));

    // If confirm=true, actually import
    if (req.body?.confirm === 'true' || req.query?.confirm === 'true') {
      const docs = rows.map(row => ({
        gameName: row['ИГРА'] || row['gameName'] || row['Game'] || '',
        gameKey: row['КЛЮЧ'] || row['gameKey'] || row['Key'] || '',
        orderNumber: String(row['НОМЕР ЗАКАЗА'] || row['orderNumber'] || row['Order'] || ''),
        customerName: row['ФИО'] || row['customerName'] || row['Name'] || ''
      }));

      await ImportedOrder.insertMany(docs);
      return res.json({ ok: true, imported: docs.length });
    }

    res.json({ ok: true, preview, totalRows: rows.length });
  } catch (e) {
    console.error('Import error:', e);
    res.status(500).json({ ok: false, error: 'Ошибка импорта: ' + e.message });
  }
});

// ═══════ ADMIN: Подтверждение импорта (отдельный эндпоинт) ═══════
app.post('/api/admin/import-confirm', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'Файл не загружен' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const docs = rows.map(row => ({
      gameName: row['ИГРА'] || row['gameName'] || row['Game'] || '',
      gameKey: row['КЛЮЧ'] || row['gameKey'] || row['Key'] || '',
      orderNumber: String(row['НОМЕР ЗАКАЗА'] || row['orderNumber'] || row['Order'] || ''),
      customerName: row['ФИО'] || row['customerName'] || row['Name'] || ''
    }));

    await ImportedOrder.insertMany(docs);
    res.json({ ok: true, imported: docs.length });
  } catch (e) {
    console.error('Import confirm error:', e);
    res.status(500).json({ ok: false, error: 'Ошибка импорта: ' + e.message });
  }
});

// ═══════ ADMIN: История (все выданные) ═══════
app.get('/api/admin/history', async (req, res) => {
  try {
    const gameLinks = await GameLink.find({ keyAssigned: true }).sort({ updatedAt: -1 }).lean();
    const imported = await ImportedOrder.find().sort({ createdAt: -1 }).lean();

    res.json({ ok: true, gameLinks, imported });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Ошибка' });
  }
});

// ═══════ ПОКАЗАТЬ КЛЮЧ ═══════
app.post('/api/reveal-key', async (req, res) => {
  try {
    const { code } = req.body;
    const link = await GameLink.findOne({ code });
    if (!link || !link.keyAssigned) return res.json({ ok: false, error: 'Ключ не назначен' });

    link.keyRevealed = true;
    await link.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

// ═══════ Секретная админка ═══════
if (process.env.ADMIN_URL) {
  app.get(`/${process.env.ADMIN_URL}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });
} else {
  console.warn('ADMIN_URL is not set: secret admin route disabled');
}

// ═══════ ANTILOPAY CONFIG ═══════
const ANTILOPAY_SECRET_ID = process.env.ANTILOPAY_SECRET_ID || '';
const ANTILOPAY_SECRET_KEY = process.env.ANTILOPAY_SECRET_KEY || '';
const ANTILOPAY_PROJECT_ID = process.env.ANTILOPAY_PROJECT_ID || '';

const TIER_PRICES = {
  starter: { base: 1, boost: 1, respin: 1, premium: 1 },
  bronze: { base: 450, boost: 135, respin: 135, premium: 270 },
  silver: { base: 700, boost: 210, respin: 210, premium: 420 },
  gold: { base: 1000, boost: 300, respin: 300, premium: 600 },
  diamond: { base: 1500, boost: 450, respin: 450, premium: 900 }
};

function isFreshPreparedAt(dateValue, maxAgeMs = 30 * 60 * 1000) {
  if (!dateValue) return false;
  const preparedAt = new Date(dateValue).getTime();
  if (!Number.isFinite(preparedAt)) return false;
  return (Date.now() - preparedAt) < maxAgeMs;
}

function signAntilopayRequest(body) {
  const json_str = JSON.stringify(body);
  let keyPem = ANTILOPAY_SECRET_KEY.trim();
  if (keyPem.startsWith('"') && keyPem.endsWith('"')) keyPem = keyPem.slice(1, -1);
  keyPem = keyPem.replace(/\\n/g, '\n');
  try {
    const privateKey = forge.pki.privateKeyFromPem(keyPem);
    const md = forge.md.sha256.create();
    md.update(json_str, 'utf8');
    const signature = privateKey.sign(md);
    return forge.util.encode64(signature);
  } catch (e) {
    console.error('Antilopay sign error:', e.message);
    throw new Error('Ошибка подписи платежа');
  }
}

function generatePaymentOrderId(code) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${code}_${Date.now()}_${suffix}`;
}

function applyRespinResetState(link, paidType = 'normal') {
  const amountKey = paidType === 'premium' ? 'premium' : 'respin';
  const paidAmount = TIER_PRICES[link.tier]?.[amountKey] || 0;

  link.respinPaid = true;
  link.respinRequested = true;
  link.respinCount += 1;
  link.respinType = paidType;
  link.respinHistory.push({ type: paidType, amount: paidAmount, paidAt: new Date() });
  link.respinOverlayDismissed = false;
  link.oldGameKey = link.gameKey || null;
  link.oldKeyWarningShown = !!link.gameKey;
  link.oldKeyNeedsPickup = !!(link.gameKey || link.gameName || link.steamAppId);
  link.previousGameName = link.gameName || null;
  link.previousGameKey = link.gameKey || null;
  link.previousSteamAppId = link.steamAppId || null;
  link.keyRevealed = false;
  link.keyAssigned = false;
  link.gameName = null;
  link.gameKey = null;
  link.steamAppId = null;
  link.spinCompleted = false;
  link.respinNormalPaymentUrl = null;
  link.respinNormalPreparedAt = null;
  link.respinPremiumPaymentUrl = null;
  link.respinPremiumPreparedAt = null;
}

// ═══════ СОЗДАНИЕ ПЛАТЕЖА (BOOST) ═══════
app.post('/api/create-boost-payment', paymentLimiter, async (req, res) => {
  try {
    const { code } = req.body;
    const link = await GameLink.findOne({ code });
    if (!link || !link.active) return res.json({ ok: false, error: 'Ссылка недействительна' });
    if (link.spinCompleted) return res.json({ ok: false, error: 'Рулетка уже прокручена' });
    if (link.boosted || link.boostPaid) return res.json({ ok: false, error: 'Повышение шанса уже оплачено' });

    if (link.boostPaymentUrl && isFreshPreparedAt(link.boostPreparedAt)) {
      return res.json({ ok: true, payment_url: link.boostPaymentUrl, order_id: link.boostOrderId, preloaded: true });
    }

    const amount = TIER_PRICES[link.tier].boost;
    const order_id = generatePaymentOrderId(code);

    const body = {
      project_identificator: ANTILOPAY_PROJECT_ID,
      amount, order_id, currency: 'RUB',
      product_name: `Дополнительная опция (${link.tier})`,
      product_type: 'services',
      description: 'Сервисная опция для цифрового товара',
      success_url: `${getPublicBaseUrl(req)}/g/${code}?boost_success=1`,
      fail_url: `${getPublicBaseUrl(req)}/g/${code}?boost_failed=1`,
      customer: { email: 'support@codenext.ru' },
    };

    const signature = signAntilopayRequest(body);

    const response = await fetch('https://lk.antilopay.com/api/v1/payment/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Apay-Secret-Id': ANTILOPAY_SECRET_ID,
        'X-Apay-Sign': signature,
        'X-Apay-Sign-Version': '1'
      },
      body: JSON.stringify(body)
    });

    const result = await response.json();
    if (result.code !== 0) return res.json({ ok: false, error: 'Ошибка создания платежа' });

    link.boostOrderId = order_id;
    link.boostTransactionId = result.payment_id;
    link.boostPaymentUrl = result.payment_url;
    link.boostPreparedAt = new Date();
    await link.save();

    res.json({ ok: true, payment_url: result.payment_url, order_id });
  } catch (e) {
    console.error('[BOOST] Exception:', e);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

// ═══════ СОЗДАНИЕ ПЛАТЕЖА (RESPIN) ═══════
app.post('/api/create-respin-payment', paymentLimiter, async (req, res) => {
  try {
    const { code, type } = req.body;
    const link = await GameLink.findOne({ code });
    if (!link || !link.active || !link.keyAssigned || link.keyRevealed) {
      return res.json({ ok: false, error: 'Недоступно' });
    }
    if (!['normal', 'premium'].includes(type)) return res.json({ ok: false, error: 'Неверный тип' });

    const isPremium = type === 'premium';
    const existingPaymentUrl = isPremium ? link.respinPremiumPaymentUrl : link.respinNormalPaymentUrl;
    const existingOrderId = isPremium ? link.respinPremiumOrderId : link.respinNormalOrderId;
    const existingPreparedAt = isPremium ? link.respinPremiumPreparedAt : link.respinNormalPreparedAt;

    if (existingPaymentUrl && isFreshPreparedAt(existingPreparedAt)) {
      return res.json({ ok: true, payment_url: existingPaymentUrl, order_id: existingOrderId, preloaded: true });
    }

    const price_key = type === 'premium' ? 'premium' : 'respin';
    const amount = TIER_PRICES[link.tier][price_key];
    const order_id = generatePaymentOrderId(code);

    const body = {
      project_identificator: ANTILOPAY_PROJECT_ID,
      amount, order_id, currency: 'RUB',
      product_name: type === 'premium' ? 'Расширенная сервисная опция' : 'Сервисная опция',
      product_type: 'services',
      description: type === 'premium' ? 'Расширенная опция для цифрового товара' : 'Дополнительная опция для цифрового товара',
      success_url: `${getPublicBaseUrl(req)}/g/${code}?respin_success=1`,
      fail_url: `${getPublicBaseUrl(req)}/g/${code}?respin_failed=1`,
      customer: { email: 'support@codenext.ru' },
    };

    const signature = signAntilopayRequest(body);

    const response = await fetch('https://lk.antilopay.com/api/v1/payment/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Apay-Secret-Id': ANTILOPAY_SECRET_ID,
        'X-Apay-Sign': signature,
        'X-Apay-Sign-Version': '1'
      },
      body: JSON.stringify(body)
    });

    const result = await response.json();
    if (result.code !== 0) return res.json({ ok: false, error: 'Ошибка создания платежа' });

    link.respinOrderId = order_id;
    link.respinTransactionId = result.payment_id;
    link.respinType = type;
    if (isPremium) {
      link.respinPremiumOrderId = order_id;
      link.respinPremiumTransactionId = result.payment_id;
      link.respinPremiumPaymentUrl = result.payment_url;
      link.respinPremiumPreparedAt = new Date();
    } else {
      link.respinNormalOrderId = order_id;
      link.respinNormalTransactionId = result.payment_id;
      link.respinNormalPaymentUrl = result.payment_url;
      link.respinNormalPreparedAt = new Date();
    }
    await link.save();

    res.json({ ok: true, payment_url: result.payment_url, order_id });
  } catch (e) {
    console.error('Respin payment error:', e);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

// ═══════ FALLBACK: пометить успешную перекрутку после возврата со страницы оплаты ═══════
app.post('/api/respin-success-fallback', async (req, res) => {
  try {
    const { code, type } = req.body;
    const link = await GameLink.findOne({ code });
    if (!link || !link.active || !link.keyAssigned || link.keyRevealed) {
      return res.json({ ok: false, error: 'Недоступно' });
    }
    if (link.respinRequested || !link.respinType) return res.json({ ok: true, already: true });

    const paidType = type === 'premium' ? 'premium' : 'normal';
    const hasPreparedOrder = paidType === 'premium'
      ? !!link.respinPremiumOrderId
      : !!link.respinNormalOrderId;
    if (!hasPreparedOrder) return res.json({ ok: false, error: 'Платёж не найден' });

    applyRespinResetState(link, paidType);
    await link.save();
    res.json({ ok: true });
  } catch (e) {
    console.error('Respin fallback error:', e);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

// ═══════ WEBHOOK ANTILOPAY ═══════
app.post('/api/webhook/antilopay-games', async (req, res) => {
  try {
    console.log('[WEBHOOK] Received:', JSON.stringify(req.body));
    // ═══════ Проверка подписи ═══════
    const receivedSign = req.headers['x-apay-sign'];
    if (!receivedSign) {
      console.error('[WEBHOOK] Missing signature');
      return res.status(403).send('FORBIDDEN');
    }

    let expectedSign;
    try {
      expectedSign = signAntilopayRequest(req.body);
    } catch (e) {
      console.error('[WEBHOOK] Sign generation failed:', e.message);
      return res.status(500).send('ERROR');
    }

    if (receivedSign !== expectedSign) {
      console.error('[WEBHOOK] Invalid signature');
      return res.status(403).send('FORBIDDEN');
    }
    // ═══════════════════════════════

    const { order_id, status } = req.body;
    if (status !== 'SUCCESS') return res.send('OK');

    const boostLink = await GameLink.findOne({ boostOrderId: order_id });
    if (boostLink && !boostLink.boostPaid) {
      console.log('[WEBHOOK BOOST] Matched link:', boostLink.code);
      boostLink.boostPaid = true;
      boostLink.boosted = true;
      boostLink.boostAmount = TIER_PRICES[boostLink.tier]?.boost || 0;
      boostLink.boostPaymentUrl = null;
      boostLink.boostPreparedAt = null;
      await boostLink.save();
    }

    const respinLink = await GameLink.findOne({
      $or: [{ respinOrderId: order_id }, { respinNormalOrderId: order_id }, { respinPremiumOrderId: order_id }]
    });
    if (respinLink && !respinLink.respinPaid) {
      console.log('[WEBHOOK RESPIN] Matched link:', respinLink.code);
      const paidType = order_id === respinLink.respinPremiumOrderId ? 'premium' : 'normal';
      applyRespinResetState(respinLink, paidType);
      console.log('[WEBHOOK RESPIN] Before save:', {
        code: respinLink.code,
        spinCompleted: respinLink.spinCompleted,
        keyAssigned: respinLink.keyAssigned,
        respinRequested: respinLink.respinRequested
      });
      await respinLink.save();
    }

    res.send('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    res.send('OK');
  }
});

// ═══════ Cron: очистка старых платёжных ссылок (каждые 10 минут) ═══════
setInterval(async () => {
  try {
    const expiredTime = new Date(Date.now() - 30 * 60 * 1000); // 30 минут назад

    await GameLink.updateMany(
      { boostPreparedAt: { $lt: expiredTime }, boostPaid: false },
      { $unset: { boostPaymentUrl: 1, boostPreparedAt: 1 } }
    );

    await GameLink.updateMany(
      { respinNormalPreparedAt: { $lt: expiredTime }, respinPaid: false },
      { $unset: { respinNormalPaymentUrl: 1, respinNormalPreparedAt: 1 } }
    );

    await GameLink.updateMany(
      { respinPremiumPreparedAt: { $lt: expiredTime }, respinPaid: false },
      { $unset: { respinPremiumPaymentUrl: 1, respinPremiumPreparedAt: 1 } }
    );

    console.log('[CRON] Expired payment links cleaned');
  } catch (e) {
    console.error('[CRON] Cleanup error:', e.message);
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Games server running on port ${PORT}`);
});
