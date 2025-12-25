/**
 * Artvision Bot v2.2
 * + /positions - позиции сайтов
 * + /myid - узнать свой Telegram ID
 */

import { NextRequest, NextResponse } from 'next/server';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ASANA_TOKEN = process.env.ASANA_TOKEN || '';
const ASANA_WORKSPACE = process.env.ASANA_WORKSPACE || '860693669973770';
const ASANA_PROJECT = process.env.ASANA_PROJECT || '1212305892582815';
const ADMIN_IDS = (process.env.ADMIN_IDS || '161261652').split(',').map(Number);

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ASANA_API = 'https://app.asana.com/api/1.0';

// ═══════════════════════════════════════════════════════════════
// TELEGRAM API
// ═══════════════════════════════════════════════════════════════

async function sendMessage(chatId: number, text: string) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
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
  const text = `👋 Привет, ${userName}!

Я бот <b>Artvision Portal</b>.

<b>Команды:</b>
/tasks — Задачи без сроков/исполнителей
/overdue — Просроченные задачи  
/week — Задачи на неделю
/positions — Позиции сайтов
/workload — Загрузка команды (админы)
/myid — Узнать свой Telegram ID

🔗 <a href="https://artvision-portal.vercel.app">Открыть портал</a>`;
  
  await sendMessage(chatId, text);
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
  
  await sendMessage(chatId, text);
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

async function handleWorkload(chatId: number) {
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
  
  await sendMessage(chatId, text);
}

async function handlePositions(chatId: number) {
  // Данные о позициях — пока заглушка, потом подключим API
  const text = `📊 <b>Позиции сайтов</b>

Данные из Яндекс.Вебмастер скоро будут доступны.

Пока можете посмотреть в портале:
🔗 <a href="https://artvision-portal.vercel.app">Открыть портал</a>

Или в таблице:
📋 <a href="https://docs.google.com/spreadsheets/d/17a-IY...">Google Sheets</a>`;
  
  await sendMessage(chatId, text);
}

async function handleMyId(chatId: number, userId: number, userName: string) {
  const isAdmin = ADMIN_IDS.includes(userId);
  const text = `🆔 <b>Твой Telegram ID:</b> <code>${userId}</code>

👤 Имя: ${userName}
${isAdmin ? '✅ Ты админ бота' : '❌ Ты не админ бота'}

<i>Отправь этот ID администратору, чтобы получить доступ к командам админа.</i>`;
  
  await sendMessage(chatId, text);
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
// WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════

async function processUpdate(update: any) {
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
      if (isAdmin) {
        await handleWorkload(chatId);
      } else {
        await sendMessage(chatId, `⛔ Эта команда только для админов\n\nТвой ID: <code>${userId}</code>`);
      }
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
    version: '2.2',
    commands: ['/start', '/tasks', '/overdue', '/week', '/positions', '/workload', '/myid']
  });
}
