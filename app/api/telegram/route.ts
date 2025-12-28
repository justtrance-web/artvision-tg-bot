/**
 * Artvision Bot v3.0
 * БЕЗ ASANA (временно отключено)
 * + Голосовые: Yandex SpeechKit (STT) + Claude (понимание)
 * + Mini App интеграция
 */

import { NextRequest, NextResponse } from 'next/server';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '161261562,161261652').split(',').map(Number);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const YANDEX_API_KEY = process.env.YANDEX_API_KEY || '';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || 'b1g3skikcv7e3aehpu26';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const PORTAL_URL = 'https://artvision-portal.vercel.app/webapp.html';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ═══════════════════════════════════════════════════════════════
// TELEGRAM API
// ═══════════════════════════════════════════════════════════════

interface InlineButton {
  text: string;
  url?: string;
  web_app?: { url: string };
  callback_data?: string;
}

async function sendMessage(chatId: number, text: string, buttons?: InlineButton[][]) {
  const body: any = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  
  if (buttons) {
    body.reply_markup = { inline_keyboard: buttons };
  }
  
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function answerCallback(callbackId: string, text?: string) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackId,
      text: text || ''
    })
  });
}

// ═══════════════════════════════════════════════════════════════
// GITHUB API (для голосового управления кодом)
// ═══════════════════════════════════════════════════════════════

interface GitHubFile {
  content: string;
  sha: string;
}

async function getGitHubFile(repo: string, path: string): Promise<GitHubFile | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      content: Buffer.from(data.content, 'base64').toString('utf-8'),
      sha: data.sha
    };
  } catch {
    return null;
  }
}

async function updateGitHubFile(repo: string, path: string, content: string, sha: string, message: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message,
          content: Buffer.from(content).toString('base64'),
          sha
        })
      }
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// YANDEX SPEECHKIT (STT)
// ═══════════════════════════════════════════════════════════════

async function recognizeSpeech(audioData: ArrayBuffer): Promise<string> {
  try {
    const response = await fetch(
      `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?folderId=${YANDEX_FOLDER_ID}&lang=ru-RU`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Api-Key ${YANDEX_API_KEY}`,
          'Content-Type': 'audio/ogg'
        },
        body: audioData
      }
    );
    
    if (!response.ok) {
      console.error('Yandex STT error:', response.status);
      return '';
    }
    
    const data = await response.json();
    return data.result || '';
  } catch (error) {
    console.error('Speech recognition error:', error);
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE API
// ═══════════════════════════════════════════════════════════════

async function askClaude(prompt: string, systemPrompt?: string): Promise<string> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt || 'Ты — помощник SEO-агентства Artvision. Отвечай кратко и по делу на русском.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    
    if (!response.ok) return '';
    const data = await response.json();
    return data.content?.[0]?.text || '';
  } catch {
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════
// VOICE HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleVoice(chatId: number, fileId: string, userId: number, userName: string) {
  try {
    // 1. Получаем файл
    const fileResp = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const fileData = await fileResp.json();
    
    if (!fileData.ok) {
      await sendMessage(chatId, '❌ Не удалось получить голосовое сообщение');
      return;
    }
    
    const filePath = fileData.result.file_path;
    const audioResp = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    const audioBuffer = await audioResp.arrayBuffer();
    
    // 2. Распознаём речь
    const recognizedText = await recognizeSpeech(audioBuffer);
    
    if (!recognizedText) {
      await sendMessage(chatId, '❌ Не удалось распознать речь. Попробуйте ещё раз.');
      return;
    }
    
    // 3. Анализируем через Claude
    const analysis = await askClaude(
      `Пользователь сказал: "${recognizedText}"
      
Определи тип запроса:
1. Если это вопрос про SEO, маркетинг, сайты — ответь на него
2. Если это запрос на создание задачи — скажи что функция временно недоступна
3. Если непонятно — попроси уточнить

Отвечай кратко.`,
      'Ты — голосовой помощник SEO-агентства Artvision.'
    );
    
    await sendMessage(chatId, `🎙 <i>"${recognizedText}"</i>\n\n${analysis}`);
    
  } catch (error) {
    console.error('Voice handler error:', error);
    await sendMessage(chatId, '❌ Ошибка обработки голосового сообщения');
  }
}

// ═══════════════════════════════════════════════════════════════
// COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleStart(chatId: number, userName: string) {
  const text = `👋 Привет, ${userName}!

Я бот <b>Artvision</b> — SEO-агентства.

📊 <b>Портал</b> — статистика сайтов
🎙 <b>Голос</b> — задавайте вопросы голосом

<i>Нажмите кнопку меню для доступа к порталу</i>`;

  await sendMessage(chatId, text, [
    [
      { text: '📊 Открыть портал', web_app: { url: PORTAL_URL } }
    ],
    [
      { text: '🕐 Время', callback_data: 'cmd_time' }
    ]
  ]);
}

// ⚠️ ASANA ВРЕМЕННО ОТКЛЮЧЕНА
async function handleTasks(chatId: number) {
  await sendMessage(chatId, `⚠️ <b>Функция временно недоступна</b>

Интеграция с Asana на обслуживании.

Используйте приложение Asana напрямую:
📱 <a href="https://app.asana.com">app.asana.com</a>`, [
    [{ text: '📊 Открыть портал', web_app: { url: PORTAL_URL } }]
  ]);
}

async function handleOverdue(chatId: number) {
  await sendMessage(chatId, `⚠️ <b>Функция временно недоступна</b>

Интеграция с Asana на обслуживании.`);
}

async function handleWeek(chatId: number) {
  await sendMessage(chatId, `⚠️ <b>Функция временно недоступна</b>

Интеграция с Asana на обслуживании.`);
}

async function handleWorkload(chatId: number, isAdmin: boolean) {
  if (!isAdmin) {
    await sendMessage(chatId, '🔒 Только для администраторов');
    return;
  }
  await sendMessage(chatId, `⚠️ <b>Функция временно недоступна</b>

Интеграция с Asana на обслуживании.`);
}

async function handlePositions(chatId: number) {
  await sendMessage(chatId, `📈 <b>Позиции сайтов</b>

Откройте портал для просмотра статистики:`, [
    [{ text: '📊 Открыть портал', web_app: { url: PORTAL_URL } }]
  ]);
}

async function handleMyId(chatId: number, userId: number, userName: string) {
  const isAdmin = ADMIN_IDS.includes(userId);
  await sendMessage(chatId, `🆔 <b>Ваш Telegram ID:</b> <code>${userId}</code>\n👤 Имя: ${userName}\n${isAdmin ? '✅ Вы админ' : '❌ Вы не админ'}`);
}

async function handleTime(chatId: number) {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const timeStr = msk.toISOString().slice(11, 19);
  const dateStr = msk.toISOString().slice(0, 10).split('-').reverse().join('.');
  
  await sendMessage(chatId, `🕐 <b>Московское время:</b>\n\n<code>${timeStr}</code>\n📅 ${dateStr}`);
}

async function handleHelp(chatId: number) {
  await sendMessage(chatId, `📖 <b>Команды бота:</b>

/start — Главное меню
/positions — Позиции сайтов
/time — Текущее время
/myid — Ваш Telegram ID
/help — Эта справка

🎙 <b>Голосовые сообщения:</b>
Отправьте голосовое — я отвечу на вопрос

📊 <b>Портал:</b>
Нажмите кнопку меню внизу`, [
    [{ text: '📊 Открыть портал', web_app: { url: PORTAL_URL } }]
  ]);
}

// ═══════════════════════════════════════════════════════════════
// CALLBACK HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleCallback(callbackId: string, data: string, chatId: number, userId: number) {
  const isAdmin = ADMIN_IDS.includes(userId);
  
  await answerCallback(callbackId);
  
  switch (data) {
    case 'cmd_tasks': await handleTasks(chatId); break;
    case 'cmd_week': await handleWeek(chatId); break;
    case 'cmd_overdue': await handleOverdue(chatId); break;
    case 'cmd_workload': await handleWorkload(chatId, isAdmin); break;
    case 'cmd_time': await handleTime(chatId); break;
    default:
      if (data.startsWith('task_')) {
        await sendMessage(chatId, '⚠️ Функция временно недоступна');
      }
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════

export async function GET() {
  return NextResponse.json({ 
    status: 'Artvision Bot v3.0 (without Asana)',
    webhook: '/api/telegram'
  });
}

export async function POST(request: NextRequest) {
  try {
    const update = await request.json();
    
    // Callback query (кнопки)
    if (update.callback_query) {
      const cb = update.callback_query;
      await handleCallback(
        cb.id,
        cb.data,
        cb.message?.chat?.id,
        cb.from?.id
      );
      return NextResponse.json({ ok: true });
    }
    
    const message = update.message;
    if (!message) return NextResponse.json({ ok: true });
    
    const chatId = message.chat?.id;
    const userId = message.from?.id;
    const userName = message.from?.first_name || 'User';
    const text = message.text || '';
    const isAdmin = ADMIN_IDS.includes(userId);
    
    // Голосовое сообщение
    if (message.voice) {
      await handleVoice(chatId, message.voice.file_id, userId, userName);
      return NextResponse.json({ ok: true });
    }
    
    // Команды
    const command = text.split(' ')[0].toLowerCase();
    
    switch (command) {
      case '/start':
      case '/help':
        await (command === '/start' ? handleStart(chatId, userName) : handleHelp(chatId));
        break;
      case '/tasks':
        await handleTasks(chatId);
        break;
      case '/overdue':
        await handleOverdue(chatId);
        break;
      case '/week':
        await handleWeek(chatId);
        break;
      case '/positions':
        await handlePositions(chatId);
        break;
      case '/workload':
        await handleWorkload(chatId, isAdmin);
        break;
      case '/myid':
      case '/id':
        await handleMyId(chatId, userId, userName);
        break;
      case '/time':
        await handleTime(chatId);
        break;
      default:
        // Обычный текст — отвечаем через Claude
        if (text && !text.startsWith('/')) {
          const response = await askClaude(text);
          if (response) {
            await sendMessage(chatId, response);
          }
        }
    }
    
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Bot error:', error);
    return NextResponse.json({ ok: true });
  }
}
