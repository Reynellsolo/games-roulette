require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const https = require('https');

const GameLink = require('./models/GameLink');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// ═══════ Авторизация админа ═══════
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  next();
}

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
  // https://steamcommunity.com/id/username
  // https://steamcommunity.com/profiles/76561198000000000
  const idMatch = url.match(/steamcommunity\.com\/id\/([^\/\?]+)/);
  const profileMatch = url.match(/steamcommunity\.com\/profiles\/(\d+)/);

  if (profileMatch) {
    return { type: 'steamid64', value: profileMatch[1] };
  }
  if (idMatch) {
    return { type: 'vanity', value: idMatch[1] };
  }
  return null;
}

// ═══════ API: Проверка Steam профиля ═══════
app.post('/api/check-steam', async (req, res) => {
  try {
    const { steamUrl } = req.body;

    if (!steamUrl) {
      return res.json({ ok: false, error: 'Укажите ссылку на профиль Steam' });
    }

    const steamInfo = extractSteamInfo(steamUrl);
    if (!steamInfo) {
      return res.json({ ok: false, error: 'Неверный формат ссылки. Используйте: steamcommunity.com/id/... или steamcommunity.com/profiles/...' });
    }

    const STEAM_KEY = process.env.STEAM_API_KEY;
    if (!STEAM_KEY) {
      return res.json({ ok: false, error: 'Steam API ключ не настроен' });
    }

    let steamId64 = null;

    // Резолвим vanity URL
    if (steamInfo.type === 'vanity') {
      const vanityData = await steamApiRequest(
        `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${steamInfo.value}`
      );
      if (vanityData.response?.success !== 1) {
        return res.json({ ok: false, error: 'Профиль Steam не найден. Проверьте ссылку.' });
      }
      steamId64 = vanityData.response.steamid;
    } else {
      steamId64 = steamInfo.value;
    }

    // Получаем информацию о профиле
    const profileData = await steamApiRequest(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${steamId64}`
    );

    const player = profileData.response?.players?.[0];
    if (!player) {
      return res.json({ ok: false, error: 'Профиль Steam не найден' });
    }

    // communityvisibilitystate: 1 = Private, 3 = Public
    if (player.communityvisibilitystate !== 3) {
      return res.json({
        ok: false,
        error: 'Профиль закрыт! Откройте профиль в настройках Steam: Редактировать профиль → Настройки приватности → Основные сведения → Открытый',
        profileClosed: true
      });
    }

    // Проверяем видимость игр
    const gamesData = await steamApiRequest(
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${steamId64}&include_played_free_games=1`
    );

    const gamesVisible = gamesData.response && (gamesData.response.game_count !== undefined);

    if (!gamesVisible) {
      return res.json({
        ok: false,
        error: 'Раздел с играми закрыт! Откройте: Редактировать профиль → Настройки приватности → Игровые данные → Открытый',
        gamesClosed: true,
        steamId: steamId64,
        steamName: player.personaname,
        steamAvatar: player.avatarfull
      });
    }

    // Получаем список игр для исключения дубликатов
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
    console.error('Steam check error:', e);
    res.json({ ok: false, error: 'Ошибка проверки Steam. Попробуйте позже.' });
  }
});

// ═══════ Страница рулетки ═══════
app.get('/g/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'spin.html'));
});

// ═══════ API: Проверка ссылки ═══════
app.get('/api/link/:code', async (req, res) => {
  try {
    const link = await GameLink.findOne({ code: req.params.code });
    if (!link) return res.json({ valid: false, error: 'Ссылка не найдена' });
    if (!link.active) return res.json({ valid: false, error: 'Ссылка деактивирована' });

    if (link.spinCompleted) {
      return res.json({
        valid: true,
        spinCompleted: true,
        keyAssigned: link.keyAssigned,
        keyRevealed: link.keyRevealed,
        excludeDuplicates: link.excludeDuplicates,
        steamName: link.steamName,
        steamAvatar: link.steamAvatar,
        gameName: link.gameName,
        gameKey: link.gameKey,
        steamAppId: link.steamAppId,
        tier: link.tier
      });
    }

    res.json({ valid: true, spinCompleted: false, tier: link.tier });
  } catch (e) {
    res.status(500).json({ valid: false, error: 'Ошибка сервера' });
  }
});

// ═══════ API: Прокрутка рулетки ═══════
app.post('/api/spin', async (req, res) => {
  try {
    const { code, steamProfileUrl, steamId, steamName, steamAvatar, country, excludeDuplicates } = req.body;

    const link = await GameLink.findOne({ code });
    if (!link || !link.active) {
      return res.json({ ok: false, error: 'Недействительная ссылка' });
    }

    if (link.spinCompleted) {
      return res.json({
        ok: true,
        alreadySpun: true,
        keyAssigned: link.keyAssigned,
        keyRevealed: link.keyRevealed,
        gameName: link.gameName,
        gameKey: link.gameKey,
        steamAppId: link.steamAppId
      });
    }

    link.spinCompleted = true;
    link.excludeDuplicates = excludeDuplicates || false;
    link.steamProfileUrl = steamProfileUrl || null;
    link.steamId = steamId || null;
    link.steamName = steamName || null;
    link.steamAvatar = steamAvatar || null;
    link.country = country || null;
    await link.save();

    res.json({
      ok: true,
      alreadySpun: false,
      keyAssigned: false
    });
  } catch (e) {
    console.error('Spin error:', e);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

// ═══════ ADMIN: Генерация ссылок ═══════
app.post('/api/admin/generate-links', adminAuth, async (req, res) => {
  const { count, tier, note } = req.body;

  if (!tier || !['starter', 'bronze', 'silver', 'gold', 'diamond'].includes(tier)) {
    return res.json({ ok: false, error: 'Укажите корректный tier' });
  }

  const links = [];
  for (let i = 0; i < (count || 1); i++) {
    let code = '';
    let exists = true;
    while (exists) {
      code = crypto.randomBytes(18).toString('base64url');
      exists = Boolean(await GameLink.exists({ code }));
    }
    const link = new GameLink({ code, tier, note: note || '' });
    await link.save();
    links.push({ code, tier, url: `${process.env.BASE_URL}/games/g/${code}` });
  }

  res.json({ ok: true, links });
});

// ═══════ ADMIN: Назначить ключ ═══════
app.post('/api/admin/assign-key', adminAuth, async (req, res) => {
  const { code, gameName, gameKey, steamAppId } = req.body;

  const link = await GameLink.findOne({ code });
  if (!link) return res.json({ ok: false, error: 'Ссылка не найдена' });

  link.keyAssigned = true;
  link.gameName = gameName;
  link.gameKey = gameKey;
  link.steamAppId = steamAppId || null;
  await link.save();

  res.json({ ok: true });
});

// ═══════ ADMIN: Список ссылок ═══════
app.get('/api/admin/links', adminAuth, async (req, res) => {
  const links = await GameLink.find().sort({ createdAt: -1 });

  const stats = {
    total: links.length,
    waiting: links.filter(l => l.spinCompleted && !l.keyAssigned).length,
    completed: links.filter(l => l.keyAssigned).length,
    unused: links.filter(l => !l.spinCompleted).length,
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
app.delete('/api/admin/link/:code', adminAuth, async (req, res) => {
  await GameLink.deleteOne({ code: req.params.code });
  res.json({ ok: true });
});

// ═══════ Секретная админка ═══════
app.get(`/${process.env.ADMIN_URL}`, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Games server running on port ${PORT}`);
});

// ═══════ ANTILOPAY CONFIG ═══════
const ANTILOPAY_SECRET_ID = process.env.ANTILOPAY_SECRET_ID || '';
const ANTILOPAY_SECRET_KEY = process.env.ANTILOPAY_SECRET_KEY || '';
const ANTILOPAY_PROJECT_ID = process.env.ANTILOPAY_PROJECT_ID || '';

// ═══════ ЦЕНЫ ПО УРОВНЯМ ═══════
const TIER_PRICES = {
  starter: { base: 150, boost: 45, respin: 45, premium: 90 },
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

// ═══════ ANTILOPAY HELPERS ═══════
function signAntilopayRequest(body) {
  const json_str = JSON.stringify(body);
  
  let keyPem = ANTILOPAY_SECRET_KEY.trim();
  
  // Убираем внешние кавычки
  if (keyPem.startsWith('"') && keyPem.endsWith('"')) {
    keyPem = keyPem.slice(1, -1);
  }
  
  // Заменяем экранированные \n на настоящие
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

// ═══════ СОЗДАНИЕ ПЛАТЕЖА (BOOST) ═══════
app.post('/api/create-boost-payment', async (req, res) => {
  try {
    console.log('[BOOST] Request received:', req.body);
    const { code } = req.body;

    const link = await GameLink.findOne({ code });
    console.log('[BOOST] Link found:', link ? `tier=${link.tier}, boosted=${link.boosted}` : 'NOT FOUND');
    
    if (!link || !link.active) {
      return res.json({ ok: false, error: 'Ссылка недействительна' });
    }

    if (link.spinCompleted) {
      return res.json({ ok: false, error: 'Рулетка уже прокручена' });
    }

    if (link.boosted || link.boostPaid) {
      return res.json({ ok: false, error: 'Повышение шанса уже оплачено' });
    }

    if (link.boostPaymentUrl && isFreshPreparedAt(link.boostPreparedAt)) {
      return res.json({
        ok: true,
        payment_url: link.boostPaymentUrl,
        order_id: link.boostOrderId,
        preloaded: true
      });
    }

    const amount = TIER_PRICES[link.tier].boost;
    const order_id = `boost_${code}_${Date.now()}`;

    console.log('[BOOST] Creating payment:', { amount, order_id, tier: link.tier });

    const body = {
      project_identificator: ANTILOPAY_PROJECT_ID,
      amount,
      order_id,
      currency: 'RUB',
      product_name: `Повышенный шанс (${link.tier})`,
      product_type: 'services',
      description: `Повышение шанса на дорогую игру`,
      success_url: `${process.env.BASE_URL}/games/g/${code}?boost_success=1`,
      fail_url: `${process.env.BASE_URL}/games/g/${code}?boost_failed=1`,
      customer: { email: 'support@codenext.ru' },
    };

    console.log('[BOOST] Request body:', JSON.stringify(body, null, 2));

    const signature = signAntilopayRequest(body);
    console.log('[BOOST] Signature created:', signature.substring(0, 30) + '...');

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
    console.log('[BOOST] Antilopay response:', JSON.stringify(result, null, 2));

    if (result.code !== 0) {
      console.error('[BOOST] Antilopay error:', result);
      return res.json({ ok: false, error: 'Ошибка создания платежа' });
    }

    link.boostOrderId = order_id;
    link.boostTransactionId = result.payment_id;
    link.boostPaymentUrl = result.payment_url;
    link.boostPreparedAt = new Date();
    await link.save();

    console.log('[BOOST] Success! Payment URL:', result.payment_url);
    res.json({ ok: true, payment_url: result.payment_url, order_id });

  } catch (e) {
    console.error('[BOOST] Exception:', e);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

// ═══════ СОЗДАНИЕ ПЛАТЕЖА (RESPIN) ═══════
app.post('/api/create-respin-payment', async (req, res) => {
  try {
    const { code, type } = req.body; // type: 'normal' или 'premium'

    const link = await GameLink.findOne({ code });
    if (!link || !link.active || !link.keyAssigned || link.keyRevealed) {
      return res.json({ ok: false, error: 'Недоступно' });
    }

    if (!['normal', 'premium'].includes(type)) {
      return res.json({ ok: false, error: 'Неверный тип' });
    }

    const isPremium = type === 'premium';
    const existingPaymentUrl = isPremium ? link.respinPremiumPaymentUrl : link.respinNormalPaymentUrl;
    const existingOrderId = isPremium ? link.respinPremiumOrderId : link.respinNormalOrderId;
    const existingPreparedAt = isPremium ? link.respinPremiumPreparedAt : link.respinNormalPreparedAt;

    if (existingPaymentUrl && isFreshPreparedAt(existingPreparedAt)) {
      return res.json({
        ok: true,
        payment_url: existingPaymentUrl,
        order_id: existingOrderId,
        preloaded: true
      });
    }

    const price_key = type === 'premium' ? 'premium' : 'respin';
    const amount = TIER_PRICES[link.tier][price_key];
    const order_id = `respin_${type}_${code}_${Date.now()}`;

    const body = {
      project_identificator: ANTILOPAY_PROJECT_ID,
      amount,
      order_id,
      currency: 'RUB',
      product_name: type === 'premium' ? 'Премиум перекрутка' : 'Перекрутка',
      product_type: 'services',
      description: type === 'premium' ? 'Перекрутка с гарантией лучшей игры' : 'Перекрутка рулетки',
      success_url: `${process.env.BASE_URL}/games/g/${code}?respin_success=1`,
      fail_url: `${process.env.BASE_URL}/games/g/${code}?respin_failed=1`,
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

    if (result.code !== 0) {
      return res.json({ ok: false, error: 'Ошибка создания платежа' });
    }

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

// ═══════ WEBHOOK ANTILOPAY (ДЛЯ ДОПЛАТ) ═══════
app.post('/api/webhook/antilopay-games', async (req, res) => {
  try {
    const { order_id, status, payment_id, original_amount } = req.body;

    if (status !== 'SUCCESS') {
      return res.send('OK');
    }

    // Обработка boost
    if (order_id.startsWith('boost_')) {
      const link = await GameLink.findOne({ boostOrderId: order_id });
      if (link && !link.boostPaid) {
        link.boostPaid = true;
        link.boosted = true;
        link.boostPaymentUrl = null;
        link.boostPreparedAt = null;
        await link.save();
      }
    }

    // Обработка respin
    if (order_id.startsWith('respin_')) {
      const link = await GameLink.findOne({
        $or: [
          { respinOrderId: order_id },
          { respinNormalOrderId: order_id },
          { respinPremiumOrderId: order_id }
        ]
      });
      if (link && !link.respinPaid) {
        link.respinPaid = true;
        link.respinRequested = true;
        link.respinCount += 1;
        link.keyRevealed = false; // ключ больше не показываем
        link.respinNormalPaymentUrl = null;
        link.respinNormalPreparedAt = null;
        link.respinPremiumPaymentUrl = null;
        link.respinPremiumPreparedAt = null;
        await link.save();
      }
    }

    res.send('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    res.send('OK');
  }
});

// ═══════ ПОКАЗАТЬ КЛЮЧ ═══════
app.post('/api/reveal-key', async (req, res) => {
  try {
    const { code } = req.body;

    const link = await GameLink.findOne({ code });
    if (!link || !link.keyAssigned) {
      return res.json({ ok: false, error: 'Ключ не назначен' });
    }

    link.keyRevealed = true;
    await link.save();

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});
