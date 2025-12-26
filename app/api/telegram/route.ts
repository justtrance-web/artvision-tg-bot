/**
 * Artvision Bot v2.7
 * + Голосовые: Yandex SpeechKit (STT) + Claude (понимание)
 * + Mini App интеграция
 * + Inline кнопки
 */

import { NextRequest, NextResponse } from 'next/server';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ASANA_TOKEN = process.env.ASANA_TOKEN || '';
const ASANA_WORKSPACE = process.env.ASANA_WORKSPACE || '860693669973770';
const ASANA_PROJECT = process.env.ASANA_PROJECT || '1212305892582815';
const ADMIN_IDS = (process.env.ADMIN_IDS || '161261562,161261652').split(',').map(Number);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const YANDEX_API_KEY = process.env.YANDEX_API_KEY || '';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || 'b1g3skikcv7e3aehpu26';

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

async function createAsanaTask(name: string): Promise<any> {
  try {
    const resp = await fetch(`${ASANA_API}/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          name,
          workspace: ASANA_WORKSPACE,
          projects: [ASANA_PROJECT]
        }
      })
    });
    const data = await resp.json();
    return data.data;
  } catch (error) {
    console.error('[Asana] Create task error:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// VOICE: Yandex SpeechKit (STT) + Claude (понимание)
// ═══════════════════════════════════════════════════════════════

async function handleVoice(chatId: number, fileId: string, userId: number, userName: string) {
  const isAdmin = ADMIN_IDS.includes(userId);
  
  if (!YANDEX_API_KEY) {
    await sendMessage(chatId, '⚠️ Yandex SpeechKit не настроен.');
    return;
  }
  
  try {
    // 1. Получаем файл из Telegram
    const fileResp = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const fileData = await fileResp.json();
    
    if (!fileData.ok) {
      await sendMessage(chatId, '❌ Не удалось получить голосовое');
      return;
    }
    
    const filePath = fileData.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    
    // 2. Скачиваем аудио
    const audioResp = await fetch(fileUrl);
    const audioBuffer = await audioResp.arrayBuffer();
    
    await sendMessage(chatId, '🎙 Распознаю...');
    
    // 3. Yandex SpeechKit STT
    const speechResp = await fetch(
      `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?folderId=${YANDEX_FOLDER_ID}&lang=ru-RU`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Api-Key ${YANDEX_API_KEY}`,
          'Content-Type': 'audio/ogg'
        },
        body: audioBuffer
      }
    );
    
    if (!speechResp.ok) {
      const error = await speechResp.text();
      console.error('[Voice] Yandex STT error:', speechResp.status, error);
      await sendMessage(chatId, `❌ Ошибка распознавания: ${speechResp.status}`);
      return;
    }
    
    const speechData = await speechResp.json();
    const recognizedText = speechData.result || '';
    
    if (!recognizedText) {
      await sendMessage(chatId, '❌ Не удалось распознать речь');
      return;
    }
    
    console.log('[Voice] Recognized:', recognizedText);
    
    // 4. Claude для понимания (если есть ключ)
    if (ANTHROPIC_API_KEY) {
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          system: `Ты — помощник Artvision Portal. Пользователь: ${userName}.

Команды: /tasks (задачи без сроков), /overdue (просроченные), /week (на неделю), /positions (позиции), /workload (загрузка).

Верни JSON:
- Команда: {"action":"command","command":"/tasks"}
- Создать задачу: {"action":"create_task","name":"название"}
- Ответ: {"action":"reply","text":"ответ"}

Только JSON.`,
          messages: [{ role: 'user', content: `Сказано: "${recognizedText}"` }]
        })
      });
      
      if (claudeResp.ok) {
        const claudeData = await claudeResp.json();
        const response = claudeData.content?.[0]?.text || '';
        
        try {
          const parsed = JSON.parse(response);
          
          if (parsed.action === 'command') {
            await sendMessage(chatId, `🎙 "${recognizedText}" → ${parsed.command}`);
            const cmd = parsed.command;
            if (cmd === '/tasks') await handleTasks(chatId);
            else if (cmd === '/overdue') await handleOverdue(chatId);
            else if (cmd === '/week') await handleWeek(chatId);
            else if (cmd === '/positions') await handlePositions(chatId);
            else if (cmd === '/workload') await handleWorkload(chatId, isAdmin, userId);
            return;
          }
          
          if (parsed.action === 'create_task' && parsed.name) {
            const task = await createAsanaTask(parsed.name);
            if (task) {
              await sendMessage(chatId, `🎙 "${recognizedText}"\n\n✅ Задача: <b>${parsed.name}</b>\n🔗 https://app.asana.com/0/${ASANA_PROJECT}/${task.gid}`);
            }
            return;
          }
          
          if (parsed.action === 'reply') {
            await sendMessage(chatId, `🎙 "${recognizedText}"\n\n${parsed.text}`);
            return;
          }
        } catch (e) {
          // Не JSON — покажем как есть
        }
      }
    }
    
    // Fallback: простой парсер
    const text = recognizedText.toLowerCase();
    if (text.includes('задач') || text.includes('таск')) {
      await sendMessage(chatId, `🎙 "${recognizedText}" → /tasks`);
      await handleTasks(chatId);
    } else if (text.includes('просроч') || text.includes('overdue')) {
      await sendMessage(chatId, `🎙 "${recognizedText}" → /overdue`);
      await handleOverdue(chatId);
    } else if (text.includes('недел') || text.includes('week')) {
      await sendMessage(chatId, `🎙 "${recognizedText}" → /week`);
      await handleWeek(chatId);
    } else if (text.includes('позици')) {
      await sendMessage(chatId, `🎙 "${recognizedText}" → /positions`);
      await handlePositions(chatId);
    } else if (text.includes('загрузк') || text.includes('workload')) {
      await sendMessage(chatId, `🎙 "${recognizedText}" → /workload`);
      await handleWorkload(chatId, isAdmin, userId);
    } else {
      await sendMessage(chatId, `🎙 Распознано: "${recognizedText}"\n\nНе понял команду. Попробуй: задачи, просроченные, неделя, позиции.`);
    }
    
  } catch (error) {
    console.error('[Voice] Error:', error);
    await sendMessage(chatId, '❌ Ошибка обработки голоса');
  }
}

// ═══════════════════════════════════════════════════════════════
// КОМАНДЫ
// ═══════════════════════════════════════════════════════════════

async function handleStart(chatId: number, userName: string) {
  const text = `👋 Привет, <b>${userName}</b>!

<b>📋 Команды:</b>
/tasks — Задачи без сроков/исполнителей
/overdue — Просроченные
/week — На неделю
/positions — Позиции сайтов
/workload — Загрузка команды

<b>🎙 Голос:</b> Отправь голосовое!`;
  
  const buttons: InlineButton[][] = [
    [{ text: '🌐 Портал', web_app: { url: PORTAL_URL } }],
    [
      { text: '📋 Задачи', callback_data: 'cmd_tasks' },
      { text: '📅 Неделя', callback_data: 'cmd_week' }
    ]
  ];
  
  await sendMessage(chatId, text, buttons);
}

async function handleTasks(chatId: number) {
  const tasks = await getAsanaTasks(ASANA_PROJECT);
  const noDue = tasks.filter((t: any) => !t.due_on);
  const noAssignee = tasks.filter((t: any) => !t.assignee);
  
  let text = '📋 <b>Задачи:</b>\n\n';
  
  if (noDue.length > 0) {
    text += `⏰ <b>Без срока (${noDue.length}):</b>\n`;
    noDue.slice(0, 5).forEach((t: any) => { text += `• ${t.name}\n`; });
    if (noDue.length > 5) text += `<i>+${noDue.length - 5}</i>\n`;
    text += '\n';
  }
  
  if (noAssignee.length > 0) {
    text += `👤 <b>Без исполнителя (${noAssignee.length}):</b>\n`;
    noAssignee.slice(0, 5).forEach((t: any) => { text += `• ${t.name}\n`; });
  }
  
  if (noDue.length === 0 && noAssignee.length === 0) {
    text = '✅ Все задачи в порядке!';
  }
  
  await sendMessage(chatId, text);
}

async function handleOverdue(chatId: number) {
  const tasks = await getAsanaTasks(ASANA_PROJECT);
  const today = new Date().toISOString().split('T')[0];
  const overdue = tasks.filter((t: any) => t.due_on && t.due_on < today);
  
  if (overdue.length > 0) {
    let text = `🔴 <b>Просрочено (${overdue.length}):</b>\n\n`;
    overdue.slice(0, 10).forEach((t: any) => {
      text += `• ${t.name}\n  📅 ${t.due_on} | 👤 ${t.assignee?.name || '—'}\n\n`;
    });
    await sendMessage(chatId, text);
  } else {
    await sendMessage(chatId, '✅ Просроченных нет!');
  }
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
  
  if (weekTasks.length > 0) {
    let text = `📅 <b>На неделю (${weekTasks.length}):</b>\n\n`;
    weekTasks.slice(0, 10).forEach((t: any) => {
      text += `• ${t.name} (${t.due_on})\n`;
    });
    await sendMessage(chatId, text);
  } else {
    await sendMessage(chatId, '📅 На неделю задач нет');
  }
}

async function handlePositions(chatId: number) {
  await sendMessage(chatId, '📊 Позиции — см. портал', [
    [{ text: '📈 Открыть', web_app: { url: `${PORTAL_URL}/positions` } }]
  ]);
}

async function handleWorkload(chatId: number, isAdmin: boolean, userId: number) {
  if (!isAdmin) {
    await sendMessage(chatId, `⛔ Только для админов. Твой ID: ${userId}`);
    return;
  }
  
  const users = await getWorkspaceUsers();
  let text = '📊 <b>Загрузка:</b>\n\n';
  
  for (const user of users.slice(0, 8)) {
    const tasks = await getAsanaTasks(undefined, user.gid);
    const emoji = tasks.length > 10 ? '🔴' : tasks.length > 5 ? '🟡' : '🟢';
    text += `${emoji} ${user.name}: ${tasks.length}\n`;
  }
  
  await sendMessage(chatId, text);
}

async function handleMyId(chatId: number, userId: number, userName: string) {
  await sendMessage(chatId, `🆔 ID: <code>${userId}</code>\n👤 ${userName}\n${ADMIN_IDS.includes(userId) ? '✅ Админ' : ''}`);
}

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════

function parseCommand(text: string): string | null {
  if (!text?.startsWith('/')) return null;
  return text.split('@')[0].split(' ')[0].toLowerCase();
}

async function processCallback(callback: any) {
  const chatId = callback.message?.chat?.id;
  const userId = callback.from?.id;
  if (!chatId) return;
  
  await answerCallback(callback.id);
  const isAdmin = ADMIN_IDS.includes(userId);
  
  switch (callback.data) {
    case 'cmd_tasks': await handleTasks(chatId); break;
    case 'cmd_week': await handleWeek(chatId); break;
    case 'cmd_overdue': await handleOverdue(chatId); break;
    case 'cmd_workload': await handleWorkload(chatId, isAdmin, userId); break;
  }
}

async function processUpdate(update: any) {
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
  
  // Голосовые
  if (message.voice) {
    console.log(`[Bot] Voice from ${userName}`);
    await handleVoice(chatId, message.voice.file_id, userId, userName);
    return;
  }
  
  const text = message.text || '';
  const command = parseCommand(text);
  if (!command) return;
  
  const isAdmin = ADMIN_IDS.includes(userId);
  console.log(`[Bot] ${command} from ${userName}`);
  
  switch (command) {
    case '/start':
    case '/help':
      await handleStart(chatId, userName); break;
    case '/tasks':
      await handleTasks(chatId); break;
    case '/overdue':
      await handleOverdue(chatId); break;
    case '/week':
      await handleWeek(chatId); break;
    case '/positions':
      await handlePositions(chatId); break;
    case '/workload':
      await handleWorkload(chatId, isAdmin, userId); break;
    case '/myid':
    case '/id':
      await handleMyId(chatId, userId, userName); break;
  }
}

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
    status: 'running',
    version: '2.7',
    features: ['Voice (Yandex STT + Claude)', 'Asana', 'Mini App']
  });
}
