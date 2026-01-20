require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// Инициализация бота
const token = process.env.TELEGRAM_BOT_TOKEN;
console.log('🔑 Инициализация с токеном:', token ? '✅ Установлен' : '❌ Не установлен');

const bot = new TelegramBot(token, { polling: true });

// Инициализация Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
console.log('🗄️ Supabase URL:', supabaseUrl ? '✅ Установлен' : '❌ Не установлен');
console.log('🔐 Supabase Key:', supabaseKey ? '✅ Установлен' : '❌ Не установлен');

const supabase = createClient(supabaseUrl, supabaseKey);
const apiPort = process.env.API_PORT || 3000;

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
