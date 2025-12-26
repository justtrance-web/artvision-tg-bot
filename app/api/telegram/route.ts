/**
 * Artvision Bot v2.6
 * + Голосовые сообщения через Claude API
 * + Mini App интеграция
 * + Inline кнопки
 * + Позиции сайтов
 */

import { NextRequest, NextResponse } from 'next/server';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ASANA_TOKEN = process.env.ASANA_TOKEN || '';
const ASANA_WORKSPACE = process.env.ASANA_WORKSPACE || '860693669973770';
const ASANA_PROJECT = process.env.ASANA_PROJECT || '1212305892582815';
const ADMIN_IDS = (process.env.ADMIN_IDS || '161261562,161261652').split(',').map(Number);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.artvision.pro';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ASANA_API = 'https://app.asana.com/api/1.0';

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
// ASANA API
// ═══════════════════════════════════════════════════════════════

async function getAsanaTasks(projectId?: string, assignee?: string) {
  const params = new URLSearchParams({
    opt_fields: 'name,due_on,assignee,assignee.name,completed',
    completed_since: 'now'
  });
  
  if (projectId) params.set('project', projectId);
  if (assignee) {
    params.set('assignee', assignee);
    params.set('workspace', ASANA_WORKSPACE);
  }

  const resp = await fetch(`${ASANA_API}/tasks?${params}`, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` }
  });
  const data = await resp.json();
  return data.data || [];
}

async function getWorkspaceUsers() {
  const resp = await fetch(
    `${ASANA_API}/workspaces/${ASANA_WORKSPACE}/users?opt_fields=name,email`,
    { headers: { Authorization: `Bearer ${ASANA_TOKEN}` } }
  );
  const data = await resp.json();
  return data.data || [];
}

async function createAsanaTask(name: string, assigneeName?: string): Promise<any> {
  try {
    const body: any = {
      data: {
        name,
        workspace: ASANA_WORKSPACE,
        projects: [ASANA_PROJECT]
      }
    };
    
    const resp = await fetch(`${ASANA_API}/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    const data = await resp.json();
    return data.data;
  } catch (error) {
    console.error('[Asana] Create task error:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// VOICE HANDLER — Claude API
// ═══════════════════════════════════════════════════════════════

async function handleVoice(chatId: number, fileId: string, userId: number, userName: string) {
  const isAdmin = ADMIN_IDS.includes(userId);
  
  if (!ANTHROPIC_API_KEY) {
    await sendMessage(chatId, '⚠️ Claude API не настроен. Добавьте ANTHROPIC_API_KEY в Vercel.');
    return;
  }
  
  try {
    // 1. Получаем файл из Telegram
    const fileResp = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const fileData = await fileResp.json();
    
    if (!fileData.ok) {
      await sendMessage(chatId, '❌ Не удалось получить голосовое сообщение');
      return;
    }
    
    const filePath = fileData.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    
    // 2. Скачиваем аудио
    const audioResp = await fetch(fileUrl);
    const audioBuffer = await audioResp.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');
    
    // 3. Определяем media type (Telegram отдаёт .oga)
    const mediaType = 'audio/ogg';
    
    await sendMessage(chatId, '🎙 Распознаю...');
    
    // 4. Отправляем в Claude API
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `Ты — голосовой помощник Artvision Portal. Пользователь: ${userName} (${isAdmin ? 'админ' : 'пользователь'}).

Доступные команды:
- /tasks — задачи без сроков/исполнителей
- /overdue — просроченные задачи  
- /week — задачи на неделю
- /positions — позиции сайтов
- /workload — загрузка команды (только админ)

Если пользователь просит что-то похожее на команду — верни JSON:
{"action": "command", "command": "/tasks"}

Если просит создать задачу — верни JSON:
{"action": "create_task", "name": "название задачи"}

Если обычный вопрос — верни JSON:
{"action": "reply", "text": "твой ответ"}

ВАЖНО: Отвечай ТОЛЬКО валидным JSON, без markdown и пояснений.`,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Распознай это голосовое сообщение и определи намерение пользователя:'
            },
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: audioBase64
              }
            }
          ]
        }]
      })
    });
    
    if (!claudeResp.ok) {
      const error = await claudeResp.text();
      console.error('[Voice] Claude API error:', error);
      await sendMessage(chatId, `❌ Ошибка Claude API: ${claudeResp.status}`);
      return;
    }
    
    const claudeData = await claudeResp.json();
    const responseText = claudeData.content?.[0]?.text || '';
    
    console.log('[Voice] Claude response:', responseText);
    
    // 5. Парсим ответ
    try {
      const parsed = JSON.parse(responseText);
      
      switch (parsed.action) {
        case 'command':
          const cmd = parsed.command;
          if (cmd === '/tasks') await handleTasks(chatId);
          else if (cmd === '/overdue') await handleOverdue(chatId);
          else if (cmd === '/week') await handleWeek(chatId);
          else if (cmd === '/positions') await handlePositions(chatId);
          else if (cmd === '/workload') await handleWorkload(chatId, isAdmin, userId);
          else await sendMessage(chatId, `🎙 Понял команду: ${cmd}\n\nНо такой команды нет.`);
          break;
          
        case 'create_task':
          const taskName = parsed.name;
          if (taskName) {
            const task = await createAsanaTask(taskName);
            if (task) {
              await sendMessage(chatId, `✅ Задача создана:\n<b>${taskName}</b>\n\n🔗 https://app.asana.com/0/${ASANA_PROJECT}/${task.gid}`);
            } else {
              await sendMessage(chatId, `❌ Не удалось создать задачу`);
            }
          }
          break;
          
        case 'reply':
          await sendMessage(chatId, `🎙 ${parsed.text}`);
          break;
          
        default:
          await sendMessage(chatId, `🎙 ${responseText}`);
      }
    } catch (e) {
      await sendMessage(chatId, `🎙 ${responseText}`);
    }
    
  } catch (error) {
    console.error('[Voice] Error:', error);
    await sendMessage(chatId, '❌ Ошибка обработки голосового сообщения');
  }
}

// ═══════════════════════════════════════════════════════════════
// КОМАНДЫ БОТА
// ═══════════════════════════════════════════════════════════════

async function handleStart(chatId: number, userName: string) {
  const text = `👋 Привет, <b>${userName}</b>!

Я бот <b>Artvision Portal</b> — твой помощник в управлении проектами.

<b>📋 Команды:</b>
/tasks — Задачи без сроков/исполнителей
/overdue — Просроченные задачи  
/week — Задачи на неделю
/positions — Позиции сайтов
/workload — Загрузка команды

<b>🎙 Голос:</b>
Отправь голосовое сообщение — я пойму!

<b>🚀 Быстрый доступ:</b>`;
  
  const buttons: InlineButton[][] = [
    [{ text: '🌐 Открыть портал', web_app: { url: PORTAL_URL } }],
    [
      { text: '📋 Задачи', callback_data: 'cmd_tasks' },
      { text: '📅 Неделя', callback_data: 'cmd_week' }
    ],
    [
      { text: '🔴 Просрочено', callback_data: 'cmd_overdue' },
      { text: '📊 Загрузка', callback_data: 'cmd_workload' }
    ]
  ];
  
  await sendMessage(chatId, text, buttons);
}

async function handleTasks(chatId: number) {
  const tasks = await getAsanaTasks(ASANA_PROJECT);
  
  const noDue = tasks.filter((t: any) => !t.due_on);
  const noAssignee = tasks.filter((t: any) => !t.assignee);
  
  let text = '📋 <b>Задачи требуют внимания</b>\n\n';
  
  if (noDue.length > 0) {
    text += `⏰ <b>Без срока (${noDue.length}):</b>\n`;
    noDue.slice(0, 5).forEach((t: any) => { text += `• ${t.name}\n`; });
    if (noDue.length > 5) text += `<i>...и ещё ${noDue.length - 5}</i>\n`;
    text += '\n';
  }
  
  if (noAssignee.length > 0) {
    text += `👤 <b>Без исполнителя (${noAssignee.length}):</b>\n`;
    noAssignee.slice(0, 5).forEach((t: any) => { text += `• ${t.name}\n`; });
    if (noAssignee.length > 5) text += `<i>...и ещё ${noAssignee.length - 5}</i>\n`;
  }
  
  if (noDue.length === 0 && noAssignee.length === 0) {
    text = '✅ Все задачи имеют сроки и исполнителей!';
  }
  
  const buttons: InlineButton[][] = [
    [{ text: '🌐 Все задачи в портале', web_app: { url: `${PORTAL_URL}/tasks` } }]
  ];
  
  await sendMessage(chatId, text, buttons);
}

async function handleOverdue(chatId: number) {
  const tasks = await getAsanaTasks(ASANA_PROJECT);
  const today = new Date().toISOString().split('T')[0];
  
  const overdue = tasks.filter((t: any) => t.due_on && t.due_on < today);
  
  let text: string;
  if (overdue.length > 0) {
    text = `🔴 <b>Просроченные задачи (${overdue.length}):</b>\n\n`;
    overdue.slice(0, 10).forEach((t: any) => {
      const assignee = t.assignee?.name || '—';
      text += `• ${t.name}\n  📅 ${t.due_on} | 👤 ${assignee}\n\n`;
    });
  } else {
    text = '✅ Просроченных задач нет!';
  }
  
  await sendMessage(chatId, text);
}

async function handleWorkload(chatId: number, isAdmin: boolean, userId: number) {
  if (!isAdmin) {
    await sendMessage(chatId, `⛔ Эта команда только для админов\n\nТвой ID: <code>${userId}</code>`);
    return;
  }
  
  const users = await getWorkspaceUsers();
  
  let text = '📊 <b>Загрузка команды:</b>\n\n';
  
  for (const user of users.slice(0, 10)) {
    const tasks = await getAsanaTasks(undefined, user.gid);
    const count = tasks.length;
    
    let emoji = '🟢';
    if (count > 10) emoji = '🔴';
    else if (count > 5) emoji = '🟡';
    
    text += `${emoji} <b>${user.name}</b>: ${count} задач\n`;
  }
  
  await sendMessage(chatId, text);
}

async function handleWeek(chatId: number) {
  const tasks = await getAsanaTasks(ASANA_PROJECT);
  
  const today = new Date();
  const weekEnd = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const todayStr = today.toISOString().split('T')[0];
  const weekEndStr = weekEnd.toISOString().split('T')[0];
  
  const weekTasks = tasks.filter((t: any) => 
    t.due_on && t.due_on >= todayStr && t.due_on <= weekEndStr
  );
  
  let text: string;
  if (weekTasks.length > 0) {
    text = `📅 <b>Задачи на неделю (${weekTasks.length}):</b>\n\n`;
    
    const byDate: Record<string, any[]> = {};
    weekTasks.forEach((t: any) => {
      if (!byDate[t.due_on]) byDate[t.due_on] = [];
      byDate[t.due_on].push(t);
    });
    
    Object.keys(byDate).sort().forEach(date => {
      text += `<b>${date}:</b>\n`;
      byDate[date].forEach((t: any) => {
        const assignee = t.assignee?.name || '—';
        text += `• ${t.name} (${assignee})\n`;
      });
      text += '\n';
    });
  } else {
    text = '📅 На ближайшую неделю задач не запланировано';
  }
  
  const buttons: InlineButton[][] = [
    [{ text: '📅 Календарь в портале', web_app: { url: `${PORTAL_URL}/calendar` } }]
  ];
  
  await sendMessage(chatId, text, buttons);
}

async function handlePositions(chatId: number) {
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gjwdlbwznkwjghquhhyz.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
  
  let text = '📊 <b>Позиции сайтов</b>\n\n';
  
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/positions?select=query,position,clicks,ctr,client_id,clients(name,domain)&order=position.asc&limit=15`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
    
    const positions = await resp.json();
    
    if (Array.isArray(positions) && positions.length > 0) {
      const byClient: Record<string, any[]> = {};
      for (const p of positions) {
        const clientName = p.clients?.name || 'Неизвестный';
        if (!byClient[clientName]) byClient[clientName] = [];
        byClient[clientName].push(p);
      }
      
      for (const [client, items] of Object.entries(byClient)) {
        text += `🏢 <b>${client}</b>\n`;
        for (const item of items.slice(0, 3)) {
          const pos = Math.round(item.position);
          const emoji = pos <= 3 ? '🥇' : pos <= 5 ? '🥈' : pos <= 10 ? '🥉' : '📍';
          text += `${emoji} <b>${pos}</b> — ${item.query}\n`;
          text += `    👆 ${item.clicks} кликов | CTR ${item.ctr}%\n`;
        }
        text += '\n';
      }
      
      text += `<i>Обновлено: ${new Date().toLocaleDateString('ru-RU')}</i>`;
    } else {
      text += '❌ Данные позиций пока не загружены.\n\n';
      text += 'Позиции обновляются из Яндекс.Вебмастер.';
    }
  } catch (error) {
    console.error('[Positions] Error:', error);
    text += '❌ Ошибка загрузки данных.\n\n';
    text += 'Попробуйте позже или откройте портал:';
  }
  
  const buttons: InlineButton[][] = [
    [{ text: '📈 Все позиции в портале', web_app: { url: `${PORTAL_URL}/positions` } }]
  ];
  
  await sendMessage(chatId, text, buttons);
}

async function handleMyId(chatId: number, userId: number, userName: string) {
  const isAdmin = ADMIN_IDS.includes(userId);
  const text = `🆔 <b>Твой Telegram ID:</b> <code>${userId}</code>

👤 Имя: ${userName}
${isAdmin ? '✅ Ты админ бота' : '❌ Ты не админ бота'}

<i>Отправь этот ID администратору, чтобы получить доступ к командам админа.</i>`;
  
  await sendMessage(chatId, text);
}

async function handlePortal(chatId: number) {
  const text = `🌐 <b>Artvision Portal</b>

Твой персональный портал для управления проектами:`;
  
  const buttons: InlineButton[][] = [
    [{ text: '🚀 Открыть портал', web_app: { url: PORTAL_URL } }]
  ];
  
  await sendMessage(chatId, text, buttons);
}

// ═══════════════════════════════════════════════════════════════
// ПАРСЕР И CALLBACK
// ═══════════════════════════════════════════════════════════════

function parseCommand(text: string): string | null {
  if (!text || !text.startsWith('/')) return null;
  const command = text.split('@')[0].split(' ')[0].toLowerCase();
  return command;
}

async function processCallback(callback: any) {
  const callbackId = callback.id;
  const chatId = callback.message?.chat?.id;
  const userId = callback.from?.id;
  const data = callback.data;
  
  if (!chatId || !data) return;
  
  await answerCallback(callbackId);
  
  const isAdmin = ADMIN_IDS.includes(userId);
  
  switch (data) {
    case 'cmd_tasks':
      await handleTasks(chatId);
      break;
    case 'cmd_week':
      await handleWeek(chatId);
      break;
    case 'cmd_overdue':
      await handleOverdue(chatId);
      break;
    case 'cmd_workload':
      await handleWorkload(chatId, isAdmin, userId);
      break;
  }
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════

async function processUpdate(update: any) {
  // Callback query (кнопки)
  if (update.callback_query) {
    await processCallback(update.callback_query);
    return;
  }
  
  const message = update.message;
  if (!message) return;
  
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  const userName = message.from?.first_name || 'User';
  
  if (!chatId) return;
  
  // ✅ Голосовые сообщения
  if (message.voice) {
    console.log(`[Bot] Voice from ${userName} (${userId})`);
    await handleVoice(chatId, message.voice.file_id, userId, userName);
    return;
  }
  
  const text = message.text || '';
  if (!text) return;
  
  const command = parseCommand(text);
  if (!command) return;
  
  const isAdmin = ADMIN_IDS.includes(userId);
  
  console.log(`[Bot] ${command} from ${userName} (${userId}), admin: ${isAdmin}`);
  
  switch (command) {
    case '/start':
    case '/help':
      await handleStart(chatId, userName);
      break;
    case '/tasks':
      await handleTasks(chatId);
      break;
    case '/overdue':
      await handleOverdue(chatId);
      break;
    case '/workload':
      await handleWorkload(chatId, isAdmin, userId);
      break;
    case '/week':
      await handleWeek(chatId);
      break;
    case '/positions':
      await handlePositions(chatId);
      break;
    case '/myid':
    case '/id':
      await handleMyId(chatId, userId, userName);
      break;
    case '/portal':
    case '/app':
      await handlePortal(chatId);
      break;
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

export async function POST(request: NextRequest) {
  try {
    const update = await request.json();
    await processUpdate(update);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[Bot] Error:', error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ 
    status: 'Artvision Bot is running!',
    version: '2.6',
    portal_url: PORTAL_URL,
    features: ['Voice Messages', 'Claude API', 'Mini App', 'Inline Buttons', 'Supabase Positions'],
    commands: ['/start', '/tasks', '/overdue', '/week', '/positions', '/workload', '/myid', '/portal']
  });
}
