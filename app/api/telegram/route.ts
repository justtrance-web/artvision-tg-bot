/**
 * Artvision Bot v2.4
 * + Mini App интеграция
 * + Inline кнопки
 * + Позиции сайтов
 * + ENV переменная PORTAL_URL
 */

import { NextRequest, NextResponse } from 'next/server';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ASANA_TOKEN = process.env.ASANA_TOKEN || '';
const ASANA_WORKSPACE = process.env.ASANA_WORKSPACE || '860693669973770';
const ASANA_PROJECT = process.env.ASANA_PROJECT || '1212305892582815';
const ADMIN_IDS = (process.env.ADMIN_IDS || '161261562,161261652').split(',').map(Number);

// ✅ ИСПРАВЛЕНО: теперь берёт из ENV или использует Vercel URL
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
  // Получаем данные из Supabase
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gjwdlbwznkwjghquhhyz.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
  
  let text = '📊 <b>Позиции сайтов</b>\n\n';
  
  try {
    // Получаем позиции с джойном клиентов
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
      // Группируем по клиентам
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
// ПАРСЕР КОМАНД
// ═══════════════════════════════════════════════════════════════

function parseCommand(text: string): string | null {
  if (!text || !text.startsWith('/')) return null;
  const command = text.split('@')[0].split(' ')[0].toLowerCase();
  return command;
}

// ═══════════════════════════════════════════════════════════════
// CALLBACK HANDLER
// ═══════════════════════════════════════════════════════════════

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
  const text = message.text || '';
  
  if (!chatId || !text) return;
  
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
    version: '2.5',
    portal_url: PORTAL_URL,
    features: ['Mini App', 'Inline Buttons', 'Callbacks', 'ENV Config', 'Supabase Positions'],
    commands: ['/start', '/tasks', '/overdue', '/week', '/positions', '/workload', '/myid', '/portal']
  });
}
