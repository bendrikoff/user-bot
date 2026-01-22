require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');

// Инициализация бота
const token = process.env.TELEGRAM_BOT_TOKEN;
console.log('🔑 Инициализация с токеном:', token ? '✅ Установлен' : '❌ Не установлен');

const bot = new TelegramBot(token, { polling: true });

// Инициализация Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const topFunctionUrl = process.env.SUPABASE_TOP_FUNCTION_URL;
const topFunctionKey = process.env.SUPABASE_FUNCTION_KEY || supabaseKey;
console.log('🗄️ Supabase URL:', supabaseUrl ? '✅ Установлен' : '❌ Не установлен');
console.log('🔐 Supabase Key:', supabaseKey ? '✅ Установлен' : '❌ Не установлен');
console.log('🌐 Edge function URL:', topFunctionUrl ? '✅ Установлен' : '❌ Не установлен');
console.log('🔑 Edge function key:', topFunctionKey ? '✅ Установлен' : '❌ Не установлен');

const supabase = createClient(supabaseUrl, supabaseKey);
const apiPort = process.env.API_PORT || 3000;
const avatarDir = process.env.AVATAR_DIR || path.join(__dirname, 'avatars');

// Объект для хранения счётчиков в памяти
const messageCounters = {};

// Разрешённые чаты (добавьте нужные ID чатов)
const allowedChatIds = new Set([
  // Пример: -1001234567890,
  -160830561,
  324234993
]);

function isAllowed(chatId) {
  if (!allowedChatIds.size) return true; // если список пустой, разрешаем всё
  return allowedChatIds.has(chatId);
}

async function fetchTopAll(limit = 10) {
  const { data, error } = await supabase
    .from('user_messages')
    .select('*')
    .order('message_count', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function fetchTopWeekly(limit = 10) {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const { data, error } = await supabase
    .from('user_messages')
    .select('*')
    .gte('last_message_date', weekAgo.toISOString())
    .order('weekly_count', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function fetchTopDailyFromEdge(limit = 3) {
  if (!topFunctionUrl) throw new Error('SUPABASE_TOP_FUNCTION_URL не задан');
  if (!topFunctionKey) throw new Error('SUPABASE_FUNCTION_KEY не задан (или SUPABASE_KEY пуст)');

  const url = `${topFunctionUrl}?period=day`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${topFunctionKey}`,
      apikey: topFunctionKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Edge function ${response.status}: ${text}`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.slice(0, limit);
}

// Получить URL аватара пользователя по его Telegram user_id
async function getAvatarUrlById(userId) {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos || !photos.total_count || !photos.photos || !photos.photos.length) return null;

    const sizes = photos.photos[0];
    const fileId = sizes[sizes.length - 1].file_id; // самый большой размер
    const file = await bot.getFile(fileId);
    if (!file || !file.file_path) return null;

    return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  } catch (e) {
    console.error('⚠️ Ошибка получения аватара:', e);
    return null;
  }
}

// Сохраняем аватар локально под userId и возвращаем http-url для раздачи
async function downloadAvatar(userId, { force = false } = {}) {
  await fs.mkdir(avatarDir, { recursive: true });
  const filePath = path.join(avatarDir, `${userId}.jpg`);

  if (!force) {
    try {
      await fs.access(filePath);
      return { filePath, url: `http://localhost:${apiPort}/avatars/${userId}.jpg` };
    } catch (_) {
      // файла нет — идём качать
    }
  }

  const remoteUrl = await getAvatarUrlById(userId);
  if (!remoteUrl) return { filePath: null, url: null };

  const resp = await fetch(remoteUrl);
  if (!resp.ok) return { filePath: null, url: null };
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(filePath, buf);

  return { filePath, url: `http://localhost:${apiPort}/avatars/${userId}.jpg` };
}

// Обновляем профиль пользователя (аватар + имя/ник)
async function syncUserProfile(userId, username, firstName, { forceAvatar = false } = {}) {
  const { url } = await downloadAvatar(userId, { force: forceAvatar });

  try {
    const updatePayload = {
      username,
      first_name: firstName,
    };
    if (url) updatePayload.avatar_url = url;

    const { data: existing, error: selectError } = await supabase
      .from('user_messages')
      .select('user_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (selectError) throw selectError;

    if (existing) {
      const { error } = await supabase
        .from('user_messages')
        .update(updatePayload)
        .eq('user_id', userId);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('user_messages')
        .insert({
          user_id: userId,
          message_count: 0,
          weekly_count: 0,
          month_count: 0,
          day_count: 0,
          ...updatePayload,
          last_message_date: new Date().toISOString(),
        });
      if (error) throw error;
    }
  } catch (e) {
    console.error('⚠️ Ошибка обновления профиля:', e.message);
  }
}

// Загрузка счётчиков из БД при запуске
async function loadCountersFromDB() {
  try {
    const { data, error } = await supabase
      .from('user_messages')
      .select('*');
    
    if (error) throw error;
    
    if (data) {
      data.forEach(row => {
        messageCounters[row.user_id] = row.message_count;
      });
      console.log('✅ Счётчики загружены из БД');
    }
  } catch (error) {
    console.error('❌ Ошибка загрузки счётчиков:', error.message);
  }
}

// Сохранение счётчика в БД с сохранением ника и аватара
async function saveCounterToDB(userId, count, username, firstName) {
  try {
    console.log(`💾 Сохранение: ID ${userId}, Ник @${username}, Имя: ${firstName}, Счёт: ${count}`);
    
    // Получить аватар пользователя
    const avatarUrl = await getAvatarUrlById(userId);
    
    const { error } = await supabase
      .from('user_messages')
      .upsert({ 
        user_id: userId, 
        message_count: count,
        username: username,
        first_name: firstName,
        avatar_url: avatarUrl,
        last_message_date: new Date().toISOString()
      }, { onConflict: 'user_id' });
    
    if (error) {
      console.error('❌ Ошибка сохранения в БД:', error);
      throw error;
    }
    
    console.log(`✅ Успешно сохранено для ${firstName}${avatarUrl ? ' ✓ аватар загружен' : ''}`);
  } catch (error) {
    console.error('⚠️ Ошибка сохранения счётчика:', error.message);
  }
}

// Обработка входящих сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName = msg.from.first_name || 'Пользователь';
  const userUsername = msg.from.username || null;

  if (!isAllowed(chatId)) return; // игнорируем полностью чужие чаты

  console.log(`\n📨 Новое сообщение:`);
  console.log(`   Чат ID: ${chatId}`);
  console.log(`   Пользователь: ${userName} (@${userUsername || 'без ника'})`);
  console.log(`   ID пользователя: ${userId}`);
  console.log(`   Текст: ${msg.text ? msg.text.substring(0, 50) : '(медиа)'}`);

  // Пропускаем команды бота
  if (msg.text && msg.text.startsWith('/')) {
    console.log(`   ℹ️ Это команда, пропускаем подсчёт`);
    return;
  }

  // Игнорируем сообщения самого бота
  if (msg.from.is_bot) {
    console.log(`   ℹ️ Сообщение от бота, пропускаем`);
    return;
  }

  // Проверяем и загружаем аватарку если её нет
  const avatarPath = path.join(avatarDir, `${userId}.jpg`);
  try {
    await fs.access(avatarPath);
  } catch (_) {
    console.log(`   📥 Аватарка не найдена, загружаю...`);
    const { url } = await downloadAvatar(userId);
    if (url) {
      console.log(`   ✅ Аватарка загружена`);
      // Обновляем avatar_url в БД
      try {
        const { error } = await supabase
          .from('user_messages')
          .update({ avatar_url: url })
          .eq('user_id', userId);
        if (!error) {
          console.log(`   ✅ avatar_url обновлён в БД`);
        }
      } catch (e) {
        console.error(`   ⚠️ Не удалось обновить avatar_url:`, e.message);
      }
    } else {
      console.log(`   ⚠️ Не удалось загрузить аватарку`);
    }
  }

  // Вызываем RPC функцию для увеличения счётчиков
  try {
    console.log(`   📤 Вызываем increment_message_counts...`);
    const { error: rpcError } = await supabase.rpc("increment_message_counts", {
      p_user_id: userId,
      p_username: userUsername,
      p_first_name: userName,
    });

    if (rpcError) {
      console.error('❌ Ошибка при вызове RPC:', rpcError);
      throw rpcError;
    }
    console.log(`   ✅ Счётчик увеличен через RPC`);
  } catch (error) {
    console.error('⚠️ Ошибка обработки сообщения:', error.message);
  }
});

// Команда /stats
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isAllowed(chatId)) return;

  console.log(`\n📊 Команда /stats от пользователя ID: ${msg.from.id}`);

  try {
    console.log('🔍 Загрузка статистики из БД...');
    const { data, error } = await supabase
      .from('user_messages')
      .select('*')
      .order('message_count', { ascending: false })
      .limit(10);

    if (error) throw error;

    if (!data || data.length === 0) {
      console.log('⚠️ Нет данных в БД');
      bot.sendMessage(chatId, '📊 Нет данных по сообщениям.');
      return;
    }

    console.log(`✅ Получено ${data.length} записей`);

    let statsMessage = '📊 <b>ТОП 10 пользователей (всего сообщений):</b>\n\n';
    data.forEach((row, index) => {
      const nick = row.username ? `@${row.username}` : row.first_name;
      statsMessage += `${index + 1}. ${nick} - <b>${row.message_count}</b> сообщений\n`;
      console.log(`   ${index + 1}. ${nick} - ${row.message_count}`);
    });

    bot.sendMessage(chatId, statsMessage, { parse_mode: 'HTML' });
    console.log('✅ Статистика отправлена');
  } catch (error) {
    console.error('❌ Ошибка при загрузке статистики:', error);
    bot.sendMessage(chatId, '❌ Ошибка при загрузке статистики: ' + error.message);
  }
});

// Команда /weekly
bot.onText(/\/weekly/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isAllowed(chatId)) return;

  console.log(`\n📅 Команда /weekly от пользователя ID: ${msg.from.id}`);

  try {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    console.log(`🔍 Загрузка статистики за период с ${weekAgo.toLocaleDateString()}`);

    const { data, error } = await supabase
      .from('user_messages')
      .select('*')
      .gte('last_message_date', weekAgo.toISOString())
      .order('weekly_count', { ascending: false })
      .limit(10);

    if (error) throw error;

    if (!data || data.length === 0) {
      console.log('⚠️ Нет данных за неделю');
      bot.sendMessage(chatId, '📊 Нет данных по сообщениям за последнюю неделю.');
      return;
    }

    console.log(`✅ Получено ${data.length} записей`);

    let statsMessage = '📊 <b>ТОП 10 пользователей (за неделю):</b>\n\n';
    data.forEach((row, index) => {
      const nick = row.username ? `@${row.username}` : row.first_name;
      statsMessage += `${index + 1}. ${nick} - <b>${row.weekly_count || 0}</b> сообщений\n`;
      console.log(`   ${index + 1}. ${nick} - ${row.weekly_count || 0}`);
    });

    bot.sendMessage(chatId, statsMessage, { parse_mode: 'HTML' });
    console.log('✅ Еженедельная статистика отправлена');
  } catch (error) {
    console.error('❌ Ошибка при загрузке статистики:', error);
    bot.sendMessage(chatId, '❌ Ошибка при загрузке статистики: ' + error.message);
  }
});

// Команда /clear
bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAllowed(chatId)) return;

  console.log(`\n🗑️ Команда /clear от пользователя ID: ${userId}`);

  const ADMIN_ID = 123456789;

  if (userId !== ADMIN_ID) {
    console.log(`⚠️ Доступ запрещён (не администратор)`);
    bot.sendMessage(chatId, '❌ У вас нет прав для этой команды.');
    return;
  }

  try {
    console.log('🗑️ Очистка БД...');
    const { error } = await supabase
      .from('user_messages')
      .delete()
      .neq('user_id', 0);

    if (error) throw error;

    Object.keys(messageCounters).forEach(key => delete messageCounters[key]);
    console.log('✅ БД очищена');
    bot.sendMessage(chatId, '✅ Все счётчики сброшены.');
  } catch (error) {
    console.error('❌ Ошибка при сбросе:', error);
    bot.sendMessage(chatId, '❌ Ошибка при сбросе: ' + error.message);
  }
});

// Команда /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  if (!isAllowed(chatId)) return;

  console.log(`\n❓ Команда /help от пользователя ID: ${msg.from.id}`);
  
  const helpMessage = `
<b>📍 Доступные команды:</b>

/stats - показать ТОП 10 пользователей (всего сообщений)
/weekly - показать ТОП 10 пользователей (за последнюю неделю)
/help - показать эту справку
/clear - сбросить все счётчики (только администратор)

Бот автоматически считает все сообщения в чате и сохраняет ники пользователей!
`;
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
  console.log('✅ Справка отправлена');
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;

  console.log(`\n👋 Команда /start от пользователя ID: ${msg.from.id}`);

  const webAppUrl = process.env.WEB_APP_URL;
  const keyboard = webAppUrl
    ? {
        reply_markup: {
          keyboard: [[{ text: 'Открыть мини‑приложение', web_app: { url: webAppUrl } }]],
          resize_keyboard: true,
          one_time_keyboard: false,
          is_persistent: true,
        },
      }
    : undefined;

  bot.sendMessage(
    chatId,
    '👋 Привет! Я бот для подсчёта сообщений. Используйте /help для справки.',
    keyboard
  );
  console.log('✅ Приветствие отправлено' + (webAppUrl ? ' с кнопкой мини‑аппа' : ''));
});

// Команда /top - показать топ с кнопкой открытия мини-приложения
bot.onText(/\/top/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isAllowed(chatId)) return;

  console.log(`\n📊 Команда /top от пользователя ID: ${msg.from.id}`);

  try {
    const dailyTop = await fetchTopDailyFromEdge(3);
    const dailyLines = dailyTop.length
      ? dailyTop
          .map((row, index) => {
            const nick = row.username ? `@${row.username}` : row.first_name || 'Без имени';
            const count = row.day_count ?? 0;
            return `${index + 1}. ${nick} - <b>${count}</b> сообщений`;
          })
          .join('\n')
      : 'Пока нет данных за сегодня.';

    const webAppUrl = process.env.WEB_APP_URL;
    const messageBody = `📊 <b>ТОП 3 за сегодня</b>\n\n${dailyLines}` +
      (webAppUrl ? '\n\nОткройте мини-приложение, чтобы увидеть полный рейтинг участников!' : '');

    const replyMarkup = webAppUrl
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: '📊 Открыть ТОП', web_app: { url: webAppUrl } }]]
          }
        }
      : {};

    await bot.sendMessage(chatId, messageBody, { parse_mode: 'HTML', ...replyMarkup });
    console.log('✅ Сообщение с дневным ТОПом отправлено');
  } catch (error) {
    console.error('❌ Ошибка при загрузке дневного ТОПа:', error);
    bot.sendMessage(chatId, '❌ Не удалось загрузить дневной ТОП. Попробуйте позже.');
  }
});

// Обработка ошибок
bot.on('error', (error) => {
  console.error('❌ Ошибка бота:', error);
});

bot.on('polling_error', (error) => {
  console.error('❌ Ошибка polling:', error);
});

// Инициализация
console.log('\n' + '='.repeat(50));
console.log('🚀 ЗАПУСК БОТА');
console.log('='.repeat(50));
loadCountersFromDB();

console.log('🤖 Бот запущен и готов к работе...');
console.log('📢 Жду входящих сообщений...\n');

// API через Supabase REST (не нужен свой сервер)

// ============================================
// 🌐 EXPRESS API SERVER
// ============================================

const app = express();
app.use(cors());
app.use(express.json());
app.use('/avatars', express.static(avatarDir));

// API endpoint для лидерборда
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    
    console.log(`\n🌐 API запрос /api/leaderboard?period=${period}`);
    
    let data;
    let error;

    if (period === 'day') {
      // Получаем данные за день
      const result = await supabase
        .from('user_messages')
        .select('*')
        .gt('day_count', 0)
        .order('day_count', { ascending: false })
        .limit(100);
      
      data = result.data;
      error = result.error;
    } else if (period === 'week') {
      // Получаем данные за неделю
      const result = await supabase
        .from('user_messages')
        .select('*')
        .gt('week_count', 0)
        .order('week_count', { ascending: false })
        .limit(100);
      
      data = result.data;
      error = result.error;
    } else if (period === 'month') {
      // Получаем данные за месяц
      const result = await supabase
        .from('user_messages')
        .select('*')
        .gt('month_count', 0)
        .order('month_count', { ascending: false })
        .limit(100);
      
      data = result.data;
      error = result.error;
    } else {
      return res.status(400).json({ error: 'Invalid period. Use: day, week, or month' });
    }

    if (error) {
      console.error('❌ Ошибка БД:', error);
      return res.status(500).json({ error: error.message });
    }

    const items = (data || []).map((row) => ({
      ...row,
      avatar_url: row.avatar_url || null,
    }));

    console.log(`✅ Отправлено ${items.length} записей (с avatar_url)`);
    
    res.json({
      items
    });
  } catch (err) {
    console.error('❌ Ошибка API:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Запуск сервера
const PORT = process.env.API_PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🌐 API сервер запущен на http://localhost:${PORT}`);
  console.log(`📊 Leaderboard API: http://localhost:${PORT}/api/leaderboard?period=day|week|month\n`);
});
