/**
 * Artvision Bot v4.1
 * ==================
 * + Система идей от клиентов (текст + голос)
 * + Broadcast уведомления
 * + Кнопка "Хочу тоже"
 * + Голосовые: Yandex SpeechKit (STT) + Claude (понимание)
 * + Mini App интеграция
 * + ЛОГИРОВАНИЕ в Supabase (bot_logs)
 * + Health check endpoint
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
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gjwdlbwznkwjghquhhyz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

const PORTAL_URL = 'https://artvision-portal.vercel.app/webapp.html';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const BOT_VERSION = '4.1';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ═══════════════════════════════════════════════════════════════
// ЛОГИРОВАНИЕ
// ═══════════════════════════════════════════════════════════════

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

async function log(
  level: LogLevel,
  event: string,
  details?: Record<string, any>,
  userId?: number,
  chatId?: number,
  errorMessage?: string
) {
  try {
    await supabase.from('bot_logs').insert({
      level,
      event,
      details: details || null,
      user_id: userId || null,
      chat_id: chatId || null,
      error_message: errorMessage || null
    });
  } catch (e) {
    // Не падаем если логирование не работает
    console.error('Log error:', e);
  }
}

async function logError(event: string, error: any, userId?: number, chatId?: number) {
  const errorMessage = error?.message || String(error);
  const stack = error?.stack || null;
  
  try {
    await supabase.from('bot_logs').insert({
      level: 'error',
      event,
      error_message: errorMessage,
      stack_trace: stack,
      user_id: userId || null,
      chat_id: chatId || null
    });
  } catch (e) {
    console.error('LogError failed:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

async function recordHealth(service: string, status: string, responseTimeMs: number) {
  try {
    await supabase.from('bot_health').insert({
      service,
      status,
      response_time_ms: responseTimeMs
    });
    
    // Чистим старые записи (оставляем только 1000 последних)
    const { data } = await supabase
      .from('bot_health')
      .select('id')
      .order('checked_at', { ascending: false })
      .range(1000, 10000);
    
    if (data && data.length > 0) {
      const idsToDelete = data.map(r => r.id);
      await supabase.from('bot_health').delete().in('id', idsToDelete);
    }
  } catch (e) {
    console.error('Health record error:', e);
  }
}

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
  
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    const err = await response.text();
    await logError('sendMessage_failed', new Error(err), undefined, chatId);
  }
  
  return response.json();
}

async function answerCallback(callbackId: string, text?: string) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackId,
      text: text || undefined
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
  const startTime = Date.now();
  
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
    
    const responseTime = Date.now() - startTime;
    
    if (!response.ok) {
      await recordHealth('yandex_stt', 'error', responseTime);
      throw new Error(`Yandex STT error: ${response.status}`);
    }
    
    await recordHealth('yandex_stt', 'ok', responseTime);
    
    const result = await response.json();
    return result.result || '';
  } catch (error) {
    await logError('speech_recognition', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE API
// ═══════════════════════════════════════════════════════════════

async function askClaude(prompt: string, systemPrompt?: string): Promise<string> {
  const startTime = Date.now();
  
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
        max_tokens: 1000,
        system: systemPrompt || 'Ты помощник агентства Artvision. Отвечай кратко и по делу.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    
    const responseTime = Date.now() - startTime;
    
    if (!response.ok) {
      await recordHealth('claude_api', 'error', responseTime);
      throw new Error(`Claude API error: ${response.status}`);
    }
    
    await recordHealth('claude_api', 'ok', responseTime);
    
    const result = await response.json();
    return result.content[0].text;
  } catch (error) {
    await logError('claude_api', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE ОПЕРАЦИИ
// ═══════════════════════════════════════════════════════════════

async function registerClient(telegramId: number, firstName: string, username?: string) {
  const { data: existing } = await supabase
    .from('portal_clients')
    .select('id')
    .eq('telegram_id', telegramId)
    .single();
  
  if (!existing) {
    await supabase.from('portal_clients').insert({
      telegram_id: telegramId,
      telegram_username: username,
      first_name: firstName
    });
    await log('info', 'client_registered', { firstName, username }, telegramId);
  }
}

async function getClientProject(telegramId: number): Promise<string | null> {
  const { data } = await supabase
    .from('portal_clients')
    .select('project_code')
    .eq('telegram_id', telegramId)
    .single();
  
  return data?.project_code || null;
}

async function submitIdea(
  authorId: number,
  title: string,
  description: string | null,
  inputType: 'text' | 'voice',
  voiceTranscript?: string
): Promise<string> {
  const projectCode = await getClientProject(authorId);
  
  const { data, error } = await supabase
    .from('portal_ideas')
    .insert({
      author_telegram_id: authorId,
      author_project_code: projectCode,
      title,
      description,
      input_type: inputType,
      voice_transcript: voiceTranscript
    })
    .select('id')
    .single();
  
  if (error) {
    await logError('submit_idea', error, authorId);
    throw error;
  }
  
  await log('info', 'idea_submitted', { title, inputType }, authorId);
  
  return data.id;
}

async function notifyAdminsNewIdea(ideaId: string, title: string, isVoice: boolean) {
  const icon = isVoice ? '🎤' : '💡';
  const text = `${icon} <b>Новая идея!</b>\n\n"${title}"\n\nID: <code>${ideaId}</code>`;
  
  const buttons = [
    [
      { text: '✅ Одобрить', callback_data: `idea_approve_${ideaId}` },
      { text: '❌ Отклонить', callback_data: `idea_reject_${ideaId}` }
    ]
  ];
  
  for (const adminId of ADMIN_IDS) {
    await sendMessage(adminId, text, buttons);
  }
}

async function approveIdea(ideaId: string, moderatorId: number): Promise<boolean> {
  const { data: idea, error } = await supabase
    .from('portal_ideas')
    .update({
      status: 'approved',
      moderated_by: moderatorId,
      moderated_at: new Date().toISOString()
    })
    .eq('id', ideaId)
    .select('title, author_telegram_id')
    .single();
  
  if (error || !idea) {
    await logError('approve_idea', error || 'Idea not found', moderatorId);
    return false;
  }
  
  await log('info', 'idea_approved', { ideaId, title: idea.title }, moderatorId);
  
  // Уведомляем всех клиентов об одобренной идее
  const { data: clients } = await supabase
    .from('portal_clients')
    .select('telegram_id')
    .eq('notify_new_ideas', true);
  
  if (clients) {
    const text = `✨ <b>Новая фича в работе!</b>\n\n"${idea.title}"\n\nЕсли хотите такое же — нажмите кнопку:`;
    const buttons = [[{ text: '🙋 Хочу у себя тоже', callback_data: `want_${ideaId}` }]];
    
    for (const client of clients) {
      if (client.telegram_id !== idea.author_telegram_id) {
        await sendMessage(client.telegram_id, text, buttons);
      }
    }
  }
  
  return true;
}

async function rejectIdea(ideaId: string, moderatorId: number): Promise<boolean> {
  const { error } = await supabase
    .from('portal_ideas')
    .update({
      status: 'rejected',
      moderated_by: moderatorId,
      moderated_at: new Date().toISOString()
    })
    .eq('id', ideaId);
  
  if (error) {
    await logError('reject_idea', error, moderatorId);
    return false;
  }
  
  await log('info', 'idea_rejected', { ideaId }, moderatorId);
  return true;
}

async function markIdeaDone(ideaId: string, clientId: number): Promise<boolean> {
  const { data: idea, error } = await supabase
    .from('portal_ideas')
    .update({
      status: 'done',
      implemented_for_client: clientId,
      implemented_at: new Date().toISOString()
    })
    .eq('id', ideaId)
    .select('title')
    .single();
  
  if (error || !idea) return false;
  
  await log('info', 'idea_done', { ideaId, title: idea.title }, clientId);
  
  // Уведомляем всех кто хотел эту фичу
  const { data: requests } = await supabase
    .from('portal_idea_requests')
    .select('client_telegram_id')
    .eq('idea_id', ideaId)
    .eq('status', 'pending');
  
  if (requests) {
    const text = `🎉 <b>Фича готова!</b>\n\n"${idea.title}"\n\nХотите такое же у себя? Свяжитесь с нами!`;
    const buttons = [[{ text: '🙋 Хочу у себя тоже', callback_data: `want_${ideaId}` }]];
    
    for (const req of requests) {
      await sendMessage(req.client_telegram_id, text, buttons);
    }
  }
  
  return true;
}

async function requestIdea(ideaId: string, clientId: number): Promise<'ok' | 'exists' | 'error'> {
  const projectCode = await getClientProject(clientId);
  
  // Проверяем, не запрашивал ли уже
  const { data: existing } = await supabase
    .from('portal_idea_requests')
    .select('id')
    .eq('idea_id', ideaId)
    .eq('client_telegram_id', clientId)
    .single();
  
  if (existing) return 'exists';
  
  const { error } = await supabase
    .from('portal_idea_requests')
    .insert({
      idea_id: ideaId,
      client_telegram_id: clientId,
      client_project_code: projectCode
    });
  
  if (error) {
    await logError('request_idea', error, clientId);
    return 'error';
  }
  
  await log('info', 'idea_requested', { ideaId }, clientId);
  
  // Уведомляем админов
  const { data: idea } = await supabase
    .from('portal_ideas')
    .select('title')
    .eq('id', ideaId)
    .single();
  
  if (idea) {
    for (const adminId of ADMIN_IDS) {
      await sendMessage(
        adminId,
        `🙋 <b>Клиент хочет фичу!</b>\n\n"${idea.title}"\n\nClient ID: ${clientId}\nProject: ${projectCode || 'не указан'}`
      );
    }
  }
  
  return 'ok';
}

async function broadcastToAll(text: string, buttons?: InlineButton[][]) {
  const { data: clients } = await supabase
    .from('portal_clients')
    .select('telegram_id')
    .eq('is_active', true);
  
  if (!clients) return 0;
  
  let sent = 0;
  for (const client of clients) {
    try {
      await sendMessage(client.telegram_id, text, buttons);
      sent++;
    } catch (e) {
      await logError('broadcast_send', e, client.telegram_id);
    }
  }
  
  await log('info', 'broadcast_sent', { total: clients.length, sent });
  return sent;
}

async function getIdeasStats(): Promise<string> {
  const { data: ideas } = await supabase.from('portal_ideas').select('status');
  const { data: requests } = await supabase.from('portal_idea_requests').select('status');
  const { data: clients } = await supabase.from('portal_clients').select('id');
  
  const stats = {
    total: ideas?.length || 0,
    pending: ideas?.filter(i => i.status === 'pending').length || 0,
    approved: ideas?.filter(i => i.status === 'approved').length || 0,
    done: ideas?.filter(i => i.status === 'done').length || 0,
    requests: requests?.length || 0,
    clients: clients?.length || 0
  };
  
  return `📊 <b>Статистика</b>\n\n` +
    `👥 Клиентов: ${stats.clients}\n` +
    `💡 Идей всего: ${stats.total}\n` +
    `⏳ На модерации: ${stats.pending}\n` +
    `✅ Одобрено: ${stats.approved}\n` +
    `🎉 Выполнено: ${stats.done}\n` +
    `🙋 Заявок "хочу тоже": ${stats.requests}`;
}

// ═══════════════════════════════════════════════════════════════
// ОБРАБОТЧИКИ КОМАНД
// ═══════════════════════════════════════════════════════════════

const userModes: Map<number, 'awaiting_idea'> = new Map();

async function handleStart(chatId: number, userId: number, userName: string, username?: string) {
  await registerClient(userId, userName, username);
  await log('info', 'command_start', { userName, username }, userId, chatId);
  
  const text = `👋 Привет, ${userName}!\n\n` +
    `Я бот агентства <b>Artvision</b>.\n\n` +
    `<b>Что умею:</b>\n` +
    `💡 /idea — предложить идею или фичу\n` +
    `📊 /stats — статистика\n` +
    `❓ /help — помощь\n\n` +
    `Можете также отправить голосовое сообщение с идеей!`;
  
  const buttons = [
    [{ text: '💡 Предложить идею', callback_data: 'start_idea' }],
    [{ text: '📱 Открыть портал', web_app: { url: PORTAL_URL } }]
  ];
  
  await sendMessage(chatId, text, buttons);
}

async function handleIdea(chatId: number, userId: number) {
  userModes.set(userId, 'awaiting_idea');
  await log('info', 'command_idea', {}, userId, chatId);
  
  await sendMessage(
    chatId,
    '💡 <b>Предложите идею!</b>\n\n' +
    'Напишите текстом или отправьте голосовое сообщение.\n\n' +
    'Опишите:\n' +
    '• Что хотите улучшить?\n' +
    '• Какую проблему это решит?',
    [[{ text: '❌ Отмена', callback_data: 'cancel_idea' }]]
  );
}

async function handleHelp(chatId: number) {
  await sendMessage(
    chatId,
    `📖 <b>Справка</b>\n\n` +
    `<b>Команды:</b>\n` +
    `/start — начало работы\n` +
    `/idea — предложить идею\n` +
    `/stats — статистика\n` +
    `/help — эта справка\n\n` +
    `<b>Как работает:</b>\n` +
    `1. Вы предлагаете идею (текст или голос)\n` +
    `2. Модератор одобряет её\n` +
    `3. Другие клиенты видят и могут заказать\n` +
    `4. Мы реализуем и уведомляем всех`
  );
}

async function handleAdminIdeas(chatId: number, userId: number) {
  if (!ADMIN_IDS.includes(userId)) {
    await sendMessage(chatId, '🔒 Только для админов');
    return;
  }
  
  const { data: ideas } = await supabase
    .from('portal_ideas')
    .select('id, title, status, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);
  
  if (!ideas || ideas.length === 0) {
    await sendMessage(chatId, '✅ Нет идей на модерации');
    return;
  }
  
  let text = `📋 <b>Идеи на модерации (${ideas.length}):</b>\n\n`;
  
  for (const idea of ideas) {
    text += `• "${idea.title}"\n  ID: <code>${idea.id}</code>\n\n`;
  }
  
  await sendMessage(chatId, text);
}

async function handleAdminStats(chatId: number, userId: number) {
  if (!ADMIN_IDS.includes(userId)) {
    await sendMessage(chatId, '🔒 Только для админов');
    return;
  }
  
  const stats = await getIdeasStats();
  await sendMessage(chatId, stats);
}

async function handleBroadcast(chatId: number, userId: number, text: string) {
  if (!ADMIN_IDS.includes(userId)) {
    await sendMessage(chatId, '🔒 Только для админов');
    return;
  }
  
  const messageText = text.replace('/broadcast', '').trim();
  
  if (!messageText) {
    await sendMessage(chatId, '❌ Укажите текст рассылки:\n/broadcast Ваш текст');
    return;
  }
  
  const sent = await broadcastToAll(messageText);
  await sendMessage(chatId, `✅ Рассылка отправлена: ${sent} получателей`);
}

async function handleDone(chatId: number, userId: number, text: string) {
  if (!ADMIN_IDS.includes(userId)) {
    await sendMessage(chatId, '🔒 Только для админов');
    return;
  }
  
  const ideaId = text.replace('/done', '').trim();
  
  if (!ideaId) {
    await sendMessage(chatId, '❌ Укажите ID идеи:\n/done <id>');
    return;
  }
  
  const success = await markIdeaDone(ideaId, userId);
  
  if (success) {
    await sendMessage(chatId, '✅ Идея отмечена как выполненная, клиенты уведомлены');
  } else {
    await sendMessage(chatId, '❌ Идея не найдена');
  }
}

async function handleVoice(chatId: number, userId: number, fileId: string) {
  await log('info', 'voice_received', { fileId }, userId, chatId);
  
  try {
    // Получаем файл
    const fileResponse = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const fileData = await fileResponse.json();
    
    if (!fileData.ok) {
      throw new Error('Failed to get file');
    }
    
    const filePath = fileData.result.file_path;
    const audioResponse = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    const audioBuffer = await audioResponse.arrayBuffer();
    
    // Распознаём речь
    await sendMessage(chatId, '🎤 Распознаю речь...');
    const transcript = await recognizeSpeech(audioBuffer);
    
    if (!transcript) {
      await sendMessage(chatId, '❌ Не удалось распознать речь. Попробуйте ещё раз.');
      return;
    }
    
    // Понимаем смысл через Claude
    const understanding = await askClaude(
      `Пользователь отправил голосовое сообщение: "${transcript}"\n\n` +
      `Это идея или предложение по улучшению? Если да, сформулируй краткий заголовок (до 100 символов).` +
      `Если нет — ответь "НЕ_ИДЕЯ".`,
      'Ты анализируешь сообщения пользователей агентства. Отвечай только заголовком идеи или "НЕ_ИДЕЯ".'
    );
    
    if (understanding.includes('НЕ_ИДЕЯ')) {
      await sendMessage(chatId, `🎤 Распознано: "${transcript}"\n\nЕсли хотите предложить идею — напишите /idea`);
      return;
    }
    
    // Сохраняем как идею
    const ideaId = await submitIdea(userId, understanding, null, 'voice', transcript);
    
    await sendMessage(
      chatId,
      `✅ <b>Идея записана!</b>\n\n` +
      `📝 "${understanding}"\n\n` +
      `Оригинал: "${transcript}"\n\n` +
      `Модератор рассмотрит её в ближайшее время.`
    );
    
    await notifyAdminsNewIdea(ideaId, understanding, true);
    
  } catch (error) {
    await logError('voice_processing', error, userId, chatId);
    await sendMessage(chatId, '❌ Ошибка обработки голосового сообщения. Попробуйте позже.');
  }
}

async function handleTextIdea(chatId: number, userId: number, text: string) {
  userModes.delete(userId);
  
  const ideaId = await submitIdea(userId, text, null, 'text');
  
  await sendMessage(
    chatId,
    `✅ <b>Идея записана!</b>\n\n` +
    `"${text}"\n\n` +
    `Модератор рассмотрит её в ближайшее время.`
  );
  
  await notifyAdminsNewIdea(ideaId, text, false);
}

async function handleCallback(
  chatId: number,
  userId: number,
  messageId: number,
  callbackId: string,
  data: string
) {
  await log('info', 'callback', { data }, userId, chatId);
  
  if (data === 'start_idea') {
    await answerCallback(callbackId);
    await handleIdea(chatId, userId);
    return;
  }
  
  if (data === 'cancel_idea') {
    userModes.delete(userId);
    await answerCallback(callbackId, 'Отменено');
    await editMessage(chatId, messageId, '❌ Отменено');
    return;
  }
  
  if (data.startsWith('idea_approve_')) {
    if (!ADMIN_IDS.includes(userId)) {
      await answerCallback(callbackId, '🔒 Только для админов');
      return;
    }
    
    const ideaId = data.replace('idea_approve_', '');
    const success = await approveIdea(ideaId, userId);
    
    if (success) {
      await answerCallback(callbackId, '✅ Одобрено!');
      await editMessage(chatId, messageId, '✅ Идея одобрена и отправлена клиентам');
    } else {
      await answerCallback(callbackId, '❌ Ошибка');
    }
    return;
  }
  
  if (data.startsWith('idea_reject_')) {
    if (!ADMIN_IDS.includes(userId)) {
      await answerCallback(callbackId, '🔒 Только для админов');
      return;
    }
    
    const ideaId = data.replace('idea_reject_', '');
    const success = await rejectIdea(ideaId, userId);
    
    if (success) {
      await answerCallback(callbackId, '❌ Отклонено');
      await editMessage(chatId, messageId, '❌ Идея отклонена');
    } else {
      await answerCallback(callbackId, '❌ Ошибка');
    }
    return;
  }
  
  if (data.startsWith('want_')) {
    const ideaId = data.replace('want_', '');
    const result = await requestIdea(ideaId, userId);
    
    if (result === 'ok') {
      await answerCallback(callbackId, '✅ Заявка отправлена!');
    } else if (result === 'exists') {
      await answerCallback(callbackId, 'Вы уже оставляли заявку');
    } else {
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
    status: `Artvision Bot v${BOT_VERSION} (Ideas + Broadcast + Logging)`,
    webhook: '/api/telegram',
    health: '/api/telegram?health=1'
  });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    // Health check
    if (request.nextUrl.searchParams.get('health') === '1') {
      await recordHealth('bot_endpoint', 'ok', Date.now() - startTime);
      return NextResponse.json({ status: 'ok', version: BOT_VERSION });
    }
    
    const update = await request.json();
    
    // Callback query
    if (update.callback_query) {
      const cb = update.callback_query;
      await handleCallback(
        cb.message.chat.id,
        cb.from.id,
        cb.message.message_id,
        cb.id,
        cb.data
      );
      return NextResponse.json({ ok: true });
    }
    
    // Message
    const message = update.message;
    if (!message) {
      return NextResponse.json({ ok: true });
    }
    
    const chatId = message.chat.id;
    const userId = message.from.id;
    const userName = message.from.first_name || 'User';
    const username = message.from.username;
    const text = message.text || '';
    
    // Voice message
    if (message.voice) {
      await handleVoice(chatId, userId, message.voice.file_id);
      return NextResponse.json({ ok: true });
    }
    
    // Commands
    const command = text.split('@')[0].toLowerCase();
    
    switch (command) {
      case '/start':
        await handleStart(chatId, userId, userName, username);
        break;
      case '/idea':
        await handleIdea(chatId, userId);
        break;
      case '/help':
        await handleHelp(chatId);
        break;
      case '/ideas':
        await handleAdminIdeas(chatId, userId);
        break;
      case '/stats':
        await handleAdminStats(chatId, userId);
        break;
      case '/myid':
        await sendMessage(chatId, `🆔 Ваш ID: <code>${userId}</code>`);
        break;
      case '/time':
        await sendMessage(chatId, `🕐 Время сервера: ${new Date().toISOString()}`);
        break;
      default:
        // Check if user is in idea mode
        if (text.startsWith('/broadcast')) {
          await handleBroadcast(chatId, userId, text);
        } else if (text.startsWith('/done')) {
          await handleDone(chatId, userId, text);
        } else if (userModes.get(userId) === 'awaiting_idea' && text) {
          await handleTextIdea(chatId, userId, text);
        }
    }
    
    const responseTime = Date.now() - startTime;
    await recordHealth('bot_endpoint', 'ok', responseTime);
    
    return NextResponse.json({ ok: true });
    
  } catch (error) {
    await logError('main_handler', error);
    await recordHealth('bot_endpoint', 'error', Date.now() - startTime);
    return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 });
  }
}
