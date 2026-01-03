/**
 * Artvision Bot v4.0
 * ==================
 * + Система идей от клиентов (текст + голос)
 * + Broadcast уведомления
 * + Кнопка "Хочу тоже"
 * + Голосовые: Yandex SpeechKit (STT) + Claude (понимание)
 * + Mini App интеграция
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// ═══════════════════════════════════════════════════════════════
// КОНФИГУРАЦИЯ
// ═══════════════════════════════════════════════════════════════

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '161261562,161261652').split(',').map(Number);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const YANDEX_API_KEY = process.env.YANDEX_API_KEY || '';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || 'b1g3skikcv7e3aehpu26';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

const PORTAL_URL = 'https://artvision-portal.vercel.app/webapp.html';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
  
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  return resp.ok;
}

async function answerCallback(callbackId: string, text?: string) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackId,
      text: text || '',
      show_alert: !!text
    })
  });
}

async function editMessage(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]) {
  const body: any = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML'
  };
  
  if (buttons) {
    body.reply_markup = { inline_keyboard: buttons };
  }
  
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
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
    
    if (!response.ok) return '';
    const data = await response.json();
    return data.result || '';
  } catch {
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
        system: systemPrompt || 'Ты — помощник SEO-агентства Artvision. Отвечай кратко.',
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
// СИСТЕМА ИДЕЙ
// ═══════════════════════════════════════════════════════════════

// Режимы пользователей (ожидание ввода идеи)
const userModes: Map<number, 'idea_text' | 'idea_voice' | null> = new Map();

/**
 * Регистрация клиента
 */
async function registerClient(telegramId: number, firstName: string, username?: string) {
  await supabase
    .from('portal_clients')
    .upsert({
      telegram_id: telegramId,
      first_name: firstName,
      telegram_username: username,
      is_active: true,
      updated_at: new Date().toISOString()
    }, { onConflict: 'telegram_id' });
}

/**
 * Получить project_code клиента
 */
async function getClientProject(telegramId: number): Promise<string | null> {
  const { data } = await supabase
    .from('portal_clients')
    .select('project_code')
    .eq('telegram_id', telegramId)
    .single();
  return data?.project_code || null;
}

/**
 * Отправка идеи
 */
async function submitIdea(
  authorId: number,
  title: string,
  description: string,
  inputType: 'text' | 'voice',
  projectCode?: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('portal_ideas')
    .insert({
      author_telegram_id: authorId,
      author_project_code: projectCode,
      title: title.slice(0, 100),
      description,
      input_type: inputType,
      voice_transcript: inputType === 'voice' ? description : null,
      status: 'pending'
    })
    .select('id')
    .single();
  
  if (error) return null;
  return data.id;
}

/**
 * Уведомление админов о новой идее
 */
async function notifyAdminsNewIdea(ideaId: string, title: string, isVoice: boolean) {
  const icon = isVoice ? '🎤' : '💡';
  const text = `${icon} <b>Новая идея</b>

<i>${title}</i>

ID: <code>${ideaId.slice(0, 8)}</code>`;

  const buttons: InlineButton[][] = [
    [
      { text: '✅ Одобрить', callback_data: `idea_approve_${ideaId}` },
      { text: '❌ Отклонить', callback_data: `idea_reject_${ideaId}` }
    ]
  ];

  for (const adminId of ADMIN_IDS) {
    await sendMessage(adminId, text, buttons);
  }
}

/**
 * Одобрение идеи
 */
async function approveIdea(ideaId: string, moderatorId: number): Promise<boolean> {
  const { data: idea, error: fetchError } = await supabase
    .from('portal_ideas')
    .select('*')
    .eq('id', ideaId)
    .single();
  
  if (fetchError || !idea) return false;
  
  const { error } = await supabase
    .from('portal_ideas')
    .update({
      status: 'in_progress',
      moderated_by: moderatorId,
      moderated_at: new Date().toISOString(),
      public_title: idea.title
    })
    .eq('id', ideaId);
  
  if (error) return false;
  
  // Broadcast всем
  await broadcastToAll(
    `💡 <b>Новая идея в разработке</b>

<b>${idea.title}</b>

Статус: 🔨 <i>Взято в работу</i>`,
    [[{ text: '🙋 Хочу у себя тоже', callback_data: `want_${ideaId}` }]]
  );
  
  return true;
}

/**
 * Отклонение идеи
 */
async function rejectIdea(ideaId: string, moderatorId: number): Promise<boolean> {
  const { error } = await supabase
    .from('portal_ideas')
    .update({
      status: 'rejected',
      moderated_by: moderatorId,
      moderated_at: new Date().toISOString()
    })
    .eq('id', ideaId);
  
  return !error;
}

/**
 * Отметка идеи как готовой
 */
async function markIdeaDone(ideaId: string, clientId: number): Promise<boolean> {
  const { data: idea } = await supabase
    .from('portal_ideas')
    .select('title, public_title')
    .eq('id', ideaId)
    .single();
  
  if (!idea) return false;
  
  const { error } = await supabase
    .from('portal_ideas')
    .update({
      status: 'done',
      implemented_for_client: clientId,
      implemented_at: new Date().toISOString()
    })
    .eq('id', ideaId);
  
  if (error) return false;
  
  // Broadcast
  await broadcastToAll(
    `✅ <b>Функция готова!</b>

<b>${idea.public_title || idea.title}</b>

Уже работает у клиента`,
    [[{ text: '🙋 Хочу у себя тоже', callback_data: `want_${ideaId}` }]]
  );
  
  return true;
}

/**
 * Заявка "Хочу тоже"
 */
async function requestIdea(ideaId: string, clientId: number): Promise<'ok' | 'exists' | 'error'> {
  const { data: existing } = await supabase
    .from('portal_idea_requests')
    .select('id')
    .eq('idea_id', ideaId)
    .eq('client_telegram_id', clientId)
    .single();
  
  if (existing) return 'exists';
  
  const projectCode = await getClientProject(clientId);
  
  const { error } = await supabase
    .from('portal_idea_requests')
    .insert({
      idea_id: ideaId,
      client_telegram_id: clientId,
      client_project_code: projectCode,
      status: 'pending'
    });
  
  if (error) return 'error';
  
  // Уведомляем админов
  for (const adminId of ADMIN_IDS) {
    await sendMessage(adminId, `🙋 <b>Новая заявка "Хочу тоже"</b>

Клиент: ${clientId}
Идея: <code>${ideaId.slice(0, 8)}</code>`);
  }
  
  return 'ok';
}

/**
 * Broadcast всем активным клиентам
 */
async function broadcastToAll(text: string, buttons?: InlineButton[][]) {
  const { data: clients } = await supabase
    .from('portal_clients')
    .select('telegram_id')
    .eq('is_active', true);
  
  if (!clients) return;
  
  for (const client of clients) {
    await sendMessage(client.telegram_id, text, buttons);
    await new Promise(r => setTimeout(r, 50)); // Rate limit
  }
}

/**
 * Статистика идей для админа
 */
async function getIdeasStats(): Promise<string> {
  const [pending, inProgress, done, requests] = await Promise.all([
    supabase.from('portal_ideas').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('portal_ideas').select('*', { count: 'exact', head: true }).eq('status', 'in_progress'),
    supabase.from('portal_ideas').select('*', { count: 'exact', head: true }).eq('status', 'done'),
    supabase.from('portal_idea_requests').select('*', { count: 'exact', head: true })
  ]);
  
  return `📊 <b>Статистика идей</b>

⏳ На модерации: ${pending.count || 0}
🔨 В работе: ${inProgress.count || 0}
✅ Готово: ${done.count || 0}

🙋 Заявок "Хочу тоже": ${requests.count || 0}`;
}

// ═══════════════════════════════════════════════════════════════
// ОБРАБОТЧИКИ КОМАНД
// ═══════════════════════════════════════════════════════════════

async function handleStart(chatId: number, userId: number, userName: string, username?: string) {
  // Регистрируем клиента
  await registerClient(userId, userName, username);
  
  const text = `👋 Привет, ${userName}!

Я бот <b>Artvision</b> — SEO-агентства.

📊 <b>Портал</b> — статистика сайтов
💡 <b>Идея</b> — предложить улучшение
🎙 <b>Голос</b> — отправьте голосовое

<i>Ваши идеи помогают нам становиться лучше!</i>`;

  await sendMessage(chatId, text, [
    [{ text: '📊 Открыть портал', web_app: { url: PORTAL_URL } }],
    [{ text: '💡 Предложить идею', callback_data: 'start_idea' }]
  ]);
}

async function handleIdea(chatId: number, userId: number) {
  userModes.set(userId, 'idea_text');
  
  await sendMessage(chatId, `💡 <b>Предложить идею</b>

Напишите текстом или отправьте голосовое сообщение с описанием вашей идеи.

Примеры:
• "Хочу получать отчёт в PDF каждую неделю"
• "Добавьте уведомления о падении позиций"

<i>Отправьте сообщение ниже...</i>`, [
    [{ text: '❌ Отмена', callback_data: 'cancel_idea' }]
  ]);
}

async function handleHelp(chatId: number) {
  await sendMessage(chatId, `📖 <b>Команды бота</b>

/start — Главное меню
/idea — Предложить идею
/positions — Позиции сайтов
/time — Текущее время
/help — Эта справка

🎙 <b>Голосовые:</b>
Отправьте голосовое — я распознаю и отвечу

💡 <b>Идеи:</b>
Используйте /idea или кнопку в меню`, [
    [{ text: '📊 Открыть портал', web_app: { url: PORTAL_URL } }]
  ]);
}

async function handleAdminIdeas(chatId: number, userId: number) {
  if (!ADMIN_IDS.includes(userId)) {
    await sendMessage(chatId, '🔒 Только для администраторов');
    return;
  }
  
  const { data: ideas } = await supabase
    .from('portal_ideas')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);
  
  if (!ideas || ideas.length === 0) {
    await sendMessage(chatId, '✅ Нет идей на модерации');
    return;
  }
  
  let text = `📋 <b>Идеи на модерации (${ideas.length})</b>\n\n`;
  
  for (const idea of ideas) {
    const icon = idea.input_type === 'voice' ? '🎤' : '💡';
    text += `${icon} <code>${idea.id.slice(0, 8)}</code>\n`;
    text += `<i>${idea.title}</i>\n\n`;
  }
  
  await sendMessage(chatId, text);
}

async function handleAdminStats(chatId: number, userId: number) {
  if (!ADMIN_IDS.includes(userId)) {
    await sendMessage(chatId, '🔒 Только для администраторов');
    return;
  }
  
  const stats = await getIdeasStats();
  await sendMessage(chatId, stats);
}

async function handleAdminBroadcast(chatId: number, userId: number, text: string) {
  if (!ADMIN_IDS.includes(userId)) {
    await sendMessage(chatId, '🔒 Только для администраторов');
    return;
  }
  
  const message = text.replace('/broadcast ', '').trim();
  if (!message) {
    await sendMessage(chatId, 'Использование: /broadcast Текст сообщения');
    return;
  }
  
  await sendMessage(chatId, '📤 Отправляю...');
  await broadcastToAll(`📢 <b>Объявление</b>\n\n${message}`);
  await sendMessage(chatId, '✅ Broadcast отправлен');
}

async function handleAdminDone(chatId: number, userId: number, text: string) {
  if (!ADMIN_IDS.includes(userId)) {
    await sendMessage(chatId, '🔒 Только для администраторов');
    return;
  }
  
  const parts = text.split(' ');
  if (parts.length < 3) {
    await sendMessage(chatId, 'Использование: /done [idea_id] [client_telegram_id]');
    return;
  }
  
  const ideaId = parts[1];
  const clientId = parseInt(parts[2]);
  
  const success = await markIdeaDone(ideaId, clientId);
  
  if (success) {
    await sendMessage(chatId, `✅ Идея <code>${ideaId.slice(0, 8)}</code> отмечена как готовая`);
  } else {
    await sendMessage(chatId, '❌ Ошибка');
  }
}

// ═══════════════════════════════════════════════════════════════
// VOICE HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleVoice(chatId: number, fileId: string, userId: number) {
  try {
    // Получаем файл
    const fileResp = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const fileData = await fileResp.json();
    
    if (!fileData.ok) {
      await sendMessage(chatId, '❌ Не удалось получить голосовое');
      return;
    }
    
    const filePath = fileData.result.file_path;
    const audioResp = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    const audioBuffer = await audioResp.arrayBuffer();
    
    // Распознаём
    const transcript = await recognizeSpeech(audioBuffer);
    
    if (!transcript) {
      await sendMessage(chatId, '❌ Не удалось распознать речь');
      return;
    }
    
    // Проверяем режим — если ждём идею, сохраняем как идею
    if (userModes.get(userId) === 'idea_text') {
      userModes.delete(userId);
      
      const projectCode = await getClientProject(userId);
      const ideaId = await submitIdea(userId, transcript, transcript, 'voice', projectCode || undefined);
      
      if (ideaId) {
        await notifyAdminsNewIdea(ideaId, transcript, true);
        await sendMessage(chatId, `✅ <b>Идея отправлена!</b>

<i>"${transcript}"</i>

Мы рассмотрим её и сообщим о решении.`);
      } else {
        await sendMessage(chatId, '❌ Не удалось сохранить идею');
      }
      return;
    }
    
    // Обычное голосовое — отвечаем через Claude
    const response = await askClaude(transcript);
    await sendMessage(chatId, `🎙 <i>"${transcript}"</i>\n\n${response}`);
    
  } catch (error) {
    console.error('Voice error:', error);
    await sendMessage(chatId, '❌ Ошибка обработки');
  }
}

// ═══════════════════════════════════════════════════════════════
// CALLBACK HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleCallback(
  callbackId: string, 
  data: string, 
  chatId: number, 
  messageId: number,
  userId: number
) {
  // Кнопка "Предложить идею"
  if (data === 'start_idea') {
    await answerCallback(callbackId);
    await handleIdea(chatId, userId);
    return;
  }
  
  // Отмена идеи
  if (data === 'cancel_idea') {
    userModes.delete(userId);
    await answerCallback(callbackId, 'Отменено');
    await editMessage(chatId, messageId, '❌ Ввод идеи отменён');
    return;
  }
  
  // Одобрение идеи (админ)
  if (data.startsWith('idea_approve_')) {
    if (!ADMIN_IDS.includes(userId)) {
      await answerCallback(callbackId, '🔒 Только для админов');
      return;
    }
    
    const ideaId = data.replace('idea_approve_', '');
    const success = await approveIdea(ideaId, userId);
    
    if (success) {
      await answerCallback(callbackId, '✅ Одобрено и разослано');
      await editMessage(chatId, messageId, `✅ Идея <code>${ideaId.slice(0, 8)}</code> одобрена и разослана клиентам`);
    } else {
      await answerCallback(callbackId, '❌ Ошибка');
    }
    return;
  }
  
  // Отклонение идеи (админ)
  if (data.startsWith('idea_reject_')) {
    if (!ADMIN_IDS.includes(userId)) {
      await answerCallback(callbackId, '🔒 Только для админов');
      return;
    }
    
    const ideaId = data.replace('idea_reject_', '');
    const success = await rejectIdea(ideaId, userId);
    
    if (success) {
      await answerCallback(callbackId, '❌ Отклонено');
      await editMessage(chatId, messageId, `❌ Идея <code>${ideaId.slice(0, 8)}</code> отклонена`);
    } else {
      await answerCallback(callbackId, '❌ Ошибка');
    }
    return;
  }
  
  // Кнопка "Хочу тоже"
  if (data.startsWith('want_')) {
    const ideaId = data.replace('want_', '');
    const result = await requestIdea(ideaId, userId);
    
    switch (result) {
      case 'ok':
        await answerCallback(callbackId, '✅ Заявка принята! Мы свяжемся с вами');
        break;
      case 'exists':
        await answerCallback(callbackId, '⚠️ Вы уже оставляли заявку');
        break;
      default:
        await answerCallback(callbackId, '❌ Ошибка');
    }
    return;
  }
  
  await answerCallback(callbackId);
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════

export async function GET() {
  return NextResponse.json({ 
    status: 'Artvision Bot v4.0 (Ideas + Broadcast)',
    webhook: '/api/telegram'
  });
}

export async function POST(request: NextRequest) {
  try {
    const update = await request.json();
    
    // Callback query
    if (update.callback_query) {
      const cb = update.callback_query;
      await handleCallback(
        cb.id,
        cb.data,
        cb.message?.chat?.id,
        cb.message?.message_id,
        cb.from?.id
      );
      return NextResponse.json({ ok: true });
    }
    
    const message = update.message;
    if (!message) return NextResponse.json({ ok: true });
    
    const chatId = message.chat?.id;
    const userId = message.from?.id;
    const userName = message.from?.first_name || 'User';
    const username = message.from?.username;
    const text = message.text || '';
    
    // Голосовое
    if (message.voice) {
      await handleVoice(chatId, message.voice.file_id, userId);
      return NextResponse.json({ ok: true });
    }
    
    // Проверяем режим ввода идеи
    if (userModes.get(userId) === 'idea_text' && text && !text.startsWith('/')) {
      userModes.delete(userId);
      
      const projectCode = await getClientProject(userId);
      const ideaId = await submitIdea(userId, text, text, 'text', projectCode || undefined);
      
      if (ideaId) {
        await notifyAdminsNewIdea(ideaId, text, false);
        await sendMessage(chatId, `✅ <b>Идея отправлена!</b>

Мы рассмотрим её и сообщим о решении.`);
      } else {
        await sendMessage(chatId, '❌ Не удалось сохранить идею');
      }
      return NextResponse.json({ ok: true });
    }
    
    // Команды
    const command = text.split(' ')[0].toLowerCase();
    
    switch (command) {
      case '/start':
        await handleStart(chatId, userId, userName, username);
        break;
      case '/help':
        await handleHelp(chatId);
        break;
      case '/idea':
        await handleIdea(chatId, userId);
        break;
      case '/ideas':
        await handleAdminIdeas(chatId, userId);
        break;
      case '/stats':
        await handleAdminStats(chatId, userId);
        break;
      case '/broadcast':
        await handleAdminBroadcast(chatId, userId, text);
        break;
      case '/done':
        await handleAdminDone(chatId, userId, text);
        break;
      case '/time':
        const now = new Date();
        const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
        await sendMessage(chatId, `🕐 ${msk.toISOString().slice(11, 19)} МСК`);
        break;
      case '/myid':
        await sendMessage(chatId, `🆔 ${userId}`);
        break;
      default:
        // Обычный текст → Claude
        if (text && !text.startsWith('/')) {
          const response = await askClaude(text);
          if (response) await sendMessage(chatId, response);
        }
    }
    
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Bot error:', error);
    return NextResponse.json({ ok: true });
  }
}
