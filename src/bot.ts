import 'dotenv/config';
import { Telegraf, Context, Markup } from 'telegraf';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// ============================================================================
// Configuration
// ============================================================================

// Validate required environment variables
if (!process.env['TG_BOT_TOKEN']) {
  console.error('ERROR: TG_BOT_TOKEN environment variable is required');
  process.exit(1);
}
if (!process.env['ALLOWED_USER_ID']) {
  console.error('ERROR: ALLOWED_USER_ID environment variable is required');
  process.exit(1);
}

const CONFIG = {
  TG_BOT_TOKEN: process.env['TG_BOT_TOKEN'],
  ALLOWED_USER_ID: parseInt(process.env['ALLOWED_USER_ID'], 10),
  WORKDIR: process.env['WORKDIR'] || process.cwd(),
  SECRET_FILE: process.env['SECRET_FILE'] || path.join(process.cwd(), '.secret'),
  UNLOCK_TTL_MIN: parseInt(process.env['UNLOCK_TTL_MIN'] || '10', 10),
  QUANTUM_MIN: parseInt(process.env['QUANTUM_MIN'] || '10', 10),
  STATE_FILE: process.env['STATE_FILE'] || path.join(process.cwd(), 'state', 'state.json'),
  LOG_DIR: process.env['LOG_DIR'] || path.join(process.cwd(), 'logs'),
  HEARTBEAT_SEC: parseInt(process.env['HEARTBEAT_SEC'] || '25', 10),
  TAIL_LINES: parseInt(process.env['TAIL_LINES'] || '20', 10),
  RATE_LIMIT_MS: 3000,
};

// ============================================================================
// Types
// ============================================================================

type TaskStatus = 'running' | 'paused' | 'completed' | 'stopped' | 'error';

interface TaskState {
  id: string;
  taskText: string;
  status: TaskStatus;
  startedAt: number;
  quantumStartedAt: number;
  chatId: number;
  statusMsgId?: number;
  logFilePath: string;
  lastTail: string[];
  continuationCount: number;
}

interface AppState {
  unlockedUntil: number;
  currentTask: TaskState | null;
}

// ============================================================================
// Global State
// ============================================================================

let state: AppState = {
  unlockedUntil: 0,
  currentTask: null,
};

let currentProcess: ChildProcess | null = null;
let outputBuffer: string[] = [];
let heartbeatInterval: NodeJS.Timeout | null = null;
let quantumTimer: NodeJS.Timeout | null = null;
let lastRequestTime = 0;

// ============================================================================
// State Persistence
// ============================================================================

function loadState(): void {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      const data = fs.readFileSync(CONFIG.STATE_FILE, 'utf-8');
      const loaded = JSON.parse(data) as Partial<AppState>;
      state = { ...state, ...loaded };

      // If there was a running task, mark it as paused (interrupted)
      if (state.currentTask && state.currentTask.status === 'running') {
        state.currentTask.status = 'paused';
        saveState();
      }
    }
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

function saveState(): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG.STATE_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

// ============================================================================
// Security Helpers
// ============================================================================

function isAllowedUser(ctx: Context): boolean {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  return userId === CONFIG.ALLOWED_USER_ID && chatType === 'private';
}

function isUnlocked(): boolean {
  return Date.now() < state.unlockedUntil;
}

function getStoredPassword(): string | null {
  try {
    if (fs.existsSync(CONFIG.SECRET_FILE)) {
      return fs.readFileSync(CONFIG.SECRET_FILE, 'utf-8').trim();
    }
  } catch (err) {
    console.error('Failed to read secret file:', err);
  }
  return null;
}

function rateLimitCheck(): boolean {
  const now = Date.now();
  if (now - lastRequestTime < CONFIG.RATE_LIMIT_MS) {
    return false;
  }
  lastRequestTime = now;
  return true;
}

// ============================================================================
// Telegram UI Helpers
// ============================================================================

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function buildStatusText(task: TaskState): string {
  const now = Date.now();
  const totalElapsed = now - task.startedAt;
  const quantumElapsed = now - task.quantumStartedAt;
  const quantumRemaining = Math.max(0, CONFIG.QUANTUM_MIN * 60 * 1000 - quantumElapsed);

  const tail = outputBuffer.slice(-CONFIG.TAIL_LINES).join('\n') || '(no output yet)';
  const truncatedTail = tail.length > 2000 ? '...' + tail.slice(-2000) : tail;

  return [
    `📊 **Status Panel**`,
    ``,
    `**State:** ${task.status.toUpperCase()}`,
    `**Task ID:** \`${task.id.slice(0, 8)}\``,
    `**Continuation:** #${task.continuationCount}`,
    ``,
    `⏱ **Started:** ${new Date(task.startedAt).toISOString()}`,
    `⏱ **Elapsed:** ${formatDuration(totalElapsed)}`,
    `⏱ **Quantum:** ${formatDuration(quantumElapsed)} / ${formatDuration(quantumRemaining)} remaining`,
    ``,
    `📝 **Task:** ${task.taskText.slice(0, 100)}${task.taskText.length > 100 ? '...' : ''}`,
    ``,
    `📄 **Log:** \`${task.logFilePath}\``,
    ``,
    `**Last output:**`,
    '```',
    truncatedTail,
    '```',
  ].join('\n');
}

function getControlPanelKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Status', 'STATUS'),
      Markup.button.callback('⏸ Pause', 'PAUSE'),
      Markup.button.callback('🛑 Stop', 'STOP_PANEL'),
    ],
    [
      Markup.button.callback('🔒 Lock', 'LOCK'),
    ],
  ]);
}

function getPausedKeyboard(taskId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Continue', `CONTINUE:${taskId}`),
      Markup.button.callback('❌ Stop', `STOP:${taskId}`),
    ],
  ]);
}

async function sendOrEditStatusMessage(ctx: Context, text: string, keyboard?: ReturnType<typeof Markup.inlineKeyboard>): Promise<void> {
  const task = state.currentTask;
  if (!task) return;

  try {
    if (task.statusMsgId) {
      await ctx.telegram.editMessageText(
        task.chatId,
        task.statusMsgId,
        undefined,
        text,
        { parse_mode: 'Markdown', ...keyboard }
      );
    } else {
      const msg = await ctx.telegram.sendMessage(task.chatId, text, {
        parse_mode: 'Markdown',
        ...keyboard,
      });
      task.statusMsgId = msg.message_id;
      saveState();
    }
  } catch (err: unknown) {
    // If edit fails, send new message
    if (err instanceof Error && err.message.includes('message is not modified')) {
      return; // Skip if content unchanged
    }
    try {
      const msg = await ctx.telegram.sendMessage(task.chatId, text, {
        parse_mode: 'Markdown',
        ...keyboard,
      });
      task.statusMsgId = msg.message_id;
      saveState();
    } catch (sendErr) {
      console.error('Failed to send status message:', sendErr);
    }
  }
}

// ============================================================================
// Execution Engine
// ============================================================================

function appendToLog(line: string): void {
  const task = state.currentTask;
  if (!task) return;

  try {
    fs.appendFileSync(task.logFilePath, line + '\n');
  } catch (err) {
    console.error('Failed to append to log:', err);
  }
}

function buildContinuationPrompt(task: TaskState): string {
  const tail = task.lastTail.slice(-20).join('\n');
  return [
    `CONTINUATION PROMPT - Task was paused due to time limit.`,
    ``,
    `Original task: ${task.taskText}`,
    ``,
    `Working directory: ${CONFIG.WORKDIR}`,
    ``,
    `Last output before pause:`,
    '```',
    tail,
    '```',
    ``,
    `Please continue the task from where it left off. Maintain consistency with previous work.`,
  ].join('\n');
}

async function startExecution(ctx: Context, taskText: string, isResume: boolean = false): Promise<void> {
  const task = state.currentTask!;
  task.status = 'running';
  task.quantumStartedAt = Date.now();
  saveState();

  outputBuffer = [];

  const prompt = isResume ? buildContinuationPrompt(task) : taskText;

  // Escape the prompt for shell
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const command = `claude -p '${escapedPrompt}'`;

  console.log(`[EXEC] Running: ${command.slice(0, 100)}...`);
  console.log(`[EXEC] CWD: ${CONFIG.WORKDIR}`);

  // Redirect stderr to stdout for unified output capture
  const fullCommand = `${command} 2>&1`;

  currentProcess = spawn('bash', ['-c', fullCommand], {
    cwd: CONFIG.WORKDIR,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  currentProcess.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    console.log(`[STDOUT] ${text.slice(0, 200)}`);
    const lines = text.split('\n');
    for (const line of lines) {
      if (line) {
        outputBuffer.push(line);
        appendToLog(line);
      }
    }
    // Keep buffer bounded
    if (outputBuffer.length > 1000) {
      outputBuffer = outputBuffer.slice(-500);
    }
  });

  currentProcess.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    console.log(`[STDERR] ${text.slice(0, 200)}`);
    const lines = text.split('\n');
    for (const line of lines) {
      if (line) {
        outputBuffer.push(`[ERR] ${line}`);
        appendToLog(`[ERR] ${line}`);
      }
    }
  });

  currentProcess.on('error', (err) => {
    console.error(`[SPAWN ERROR] ${err.message}`);
    outputBuffer.push(`[SPAWN ERROR] ${err.message}`);
  });

  currentProcess.on('close', async (code) => {
    console.log(`[EXEC] Process exited with code: ${code}`);
    currentProcess = null;
    stopTimers();

    if (state.currentTask && state.currentTask.status === 'running') {
      state.currentTask.status = code === 0 ? 'completed' : 'error';
      state.currentTask.lastTail = outputBuffer.slice(-CONFIG.TAIL_LINES);
      saveState();

      const statusText = buildStatusText(state.currentTask);
      const finalText = statusText + `\n\n✅ **Task ${state.currentTask.status}** (exit code: ${code})`;
      await sendOrEditStatusMessage(ctx, finalText);
    }
  });

  currentProcess.on('error', async (err) => {
    console.error('Process error:', err);
    currentProcess = null;
    stopTimers();

    if (state.currentTask) {
      state.currentTask.status = 'error';
      saveState();

      await sendOrEditStatusMessage(ctx, `❌ **Execution error:** ${err.message}`);
    }
  });

  // Start heartbeat and quantum timer
  startTimers(ctx);

  // Send initial status
  const statusText = buildStatusText(task);
  await sendOrEditStatusMessage(ctx, statusText, getControlPanelKeyboard());
}

function startTimers(ctx: Context): void {
  // Heartbeat for status updates
  heartbeatInterval = setInterval(async () => {
    if (state.currentTask && state.currentTask.status === 'running') {
      const statusText = buildStatusText(state.currentTask);
      await sendOrEditStatusMessage(ctx, statusText, getControlPanelKeyboard());
    }
  }, CONFIG.HEARTBEAT_SEC * 1000);

  // Quantum timer
  quantumTimer = setTimeout(async () => {
    await pauseForQuantumTimeout(ctx);
  }, CONFIG.QUANTUM_MIN * 60 * 1000);
}

function stopTimers(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (quantumTimer) {
    clearTimeout(quantumTimer);
    quantumTimer = null;
  }
}

async function pauseForQuantumTimeout(ctx: Context): Promise<void> {
  stopTimers();

  // Kill the process
  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
  }

  if (state.currentTask) {
    state.currentTask.status = 'paused';
    state.currentTask.lastTail = outputBuffer.slice(-CONFIG.TAIL_LINES);
    saveState();

    const statusText = buildStatusText(state.currentTask);
    const pausedText = statusText + `\n\n⏸ **Quantum timeout!** Execution paused after ${CONFIG.QUANTUM_MIN} minutes.\nApprove continuation?`;
    await sendOrEditStatusMessage(ctx, pausedText, getPausedKeyboard(state.currentTask.id));
  }
}

async function stopCurrentTask(ctx: Context): Promise<void> {
  stopTimers();

  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
  }

  if (state.currentTask) {
    state.currentTask.status = 'stopped';
    state.currentTask.lastTail = outputBuffer.slice(-CONFIG.TAIL_LINES);
    saveState();

    const statusText = buildStatusText(state.currentTask);
    await sendOrEditStatusMessage(ctx, statusText + '\n\n🛑 **Task stopped by user.**');
    state.currentTask = null;
    saveState();
  }
}

async function pauseCurrentTask(ctx: Context): Promise<void> {
  stopTimers();

  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
  }

  if (state.currentTask) {
    state.currentTask.status = 'paused';
    state.currentTask.lastTail = outputBuffer.slice(-CONFIG.TAIL_LINES);
    saveState();

    const statusText = buildStatusText(state.currentTask);
    await sendOrEditStatusMessage(ctx, statusText + '\n\n⏸ **Task paused by user.**', getPausedKeyboard(state.currentTask.id));
  }
}

// ============================================================================
// Bot Setup
// ============================================================================

const bot = new Telegraf(CONFIG.TG_BOT_TOKEN);

// Middleware: ignore all non-allowed users silently
bot.use((ctx, next) => {
  if (!isAllowedUser(ctx)) {
    return; // Silently ignore
  }
  return next();
});

// /start command
bot.command('start', async (ctx) => {
  const locked = isUnlocked() ? '🔓 Unlocked' : '🔒 Locked';
  const taskStatus = state.currentTask ? `📋 Task: ${state.currentTask.status}` : '📋 No active task';

  await ctx.reply(
    [
      `${locked}`,
      `${taskStatus}`,
    ].join('\n'),
    { parse_mode: 'Markdown', ...getControlPanelKeyboard() }
  );
});

// /unlock command
bot.command('unlock', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) {
    await ctx.reply('Usage: /unlock <password>');
    return;
  }

  const storedPassword = getStoredPassword();
  if (!storedPassword) {
    await ctx.reply('❌ No password configured. Create a .secret file.');
    return;
  }

  if (args === storedPassword) {
    state.unlockedUntil = Date.now() + CONFIG.UNLOCK_TTL_MIN * 60 * 1000;
    saveState();
    await ctx.reply(`🔓 Unlocked for ${CONFIG.UNLOCK_TTL_MIN} minutes.`);
    // Delete the message containing the password
    try {
      await ctx.deleteMessage();
    } catch (err) {
      // Ignore if can't delete
    }
  } else {
    await ctx.reply('❌ Invalid password.');
  }
});

// /lock command
bot.command('lock', async (ctx) => {
  state.unlockedUntil = 0;
  saveState();
  await ctx.reply('🔒 Bot locked.');
});

// /run command
bot.command('run', async (ctx) => {
  if (!isUnlocked()) {
    await ctx.reply('🔒 Bot is locked. Use /unlock <password> first.');
    return;
  }

  if (!rateLimitCheck()) {
    await ctx.reply('⏳ Rate limited. Wait a moment.');
    return;
  }

  if (state.currentTask && (state.currentTask.status === 'running' || state.currentTask.status === 'paused')) {
    await ctx.reply(`⚠️ Task already ${state.currentTask.status}. Use /stop or /continue first.`);
    return;
  }

  const taskText = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!taskText) {
    await ctx.reply('Usage: /run <task description>');
    return;
  }

  const taskId = randomUUID();
  const logFilePath = path.join(CONFIG.LOG_DIR, `task-${taskId}.log`);

  fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });

  state.currentTask = {
    id: taskId,
    taskText,
    status: 'running',
    startedAt: Date.now(),
    quantumStartedAt: Date.now(),
    chatId: ctx.chat!.id,
    logFilePath,
    lastTail: [],
    continuationCount: 0,
  };
  saveState();

  await ctx.reply(`🚀 Starting task: ${taskText.slice(0, 100)}...`);
  await startExecution(ctx, taskText);
});

// /status command
bot.command('status', async (ctx) => {
  if (!state.currentTask) {
    await ctx.reply('📋 No active task.');
    return;
  }

  const statusText = buildStatusText(state.currentTask);
  const keyboard = state.currentTask.status === 'paused'
    ? getPausedKeyboard(state.currentTask.id)
    : getControlPanelKeyboard();
  await ctx.reply(statusText, { parse_mode: 'Markdown', ...keyboard });
});

// /continue command
bot.command('continue', async (ctx) => {
  if (!isUnlocked()) {
    await ctx.reply('🔒 Bot is locked. Use /unlock <password> first.');
    return;
  }

  if (!state.currentTask || state.currentTask.status !== 'paused') {
    await ctx.reply('⚠️ No paused task to continue.');
    return;
  }

  state.currentTask.continuationCount++;
  saveState();

  await ctx.reply(`▶️ Continuing task (continuation #${state.currentTask.continuationCount})...`);
  await startExecution(ctx, state.currentTask.taskText, true);
});

// /stop command
bot.command('stop', async (ctx) => {
  if (!state.currentTask) {
    await ctx.reply('📋 No active task to stop.');
    return;
  }

  await stopCurrentTask(ctx);
  await ctx.reply('🛑 Task stopped.');
});

// /cancel command
bot.command('cancel', async (ctx) => {
  if (!state.currentTask) {
    await ctx.reply('📋 No active task to cancel.');
    return;
  }

  stopTimers();
  if (currentProcess) {
    currentProcess.kill('SIGKILL'); // Force kill
    currentProcess = null;
  }

  state.currentTask.status = 'stopped';
  saveState();

  await ctx.reply('❌ Task cancelled immediately.');
  state.currentTask = null;
  saveState();
});

// /pause command
bot.command('pause', async (ctx) => {
  if (!state.currentTask || state.currentTask.status !== 'running') {
    await ctx.reply('⚠️ No running task to pause.');
    return;
  }

  await pauseCurrentTask(ctx);
});

// Callback queries
bot.on('callback_query', async (ctx) => {
  const query = ctx.callbackQuery;
  if (!('data' in query)) return;

  const data = query.data;
  const userId = query.from.id;

  // Verify allowed user
  if (userId !== CONFIG.ALLOWED_USER_ID) {
    return; // Silently ignore
  }

  // Handle STATUS button
  if (data === 'STATUS') {
    if (!state.currentTask) {
      await ctx.answerCbQuery('No active task');
      return;
    }
    const statusText = buildStatusText(state.currentTask);
    await ctx.answerCbQuery('Status updated');
    await sendOrEditStatusMessage(ctx, statusText, getControlPanelKeyboard());
    return;
  }

  // Handle LOCK button
  if (data === 'LOCK') {
    state.unlockedUntil = 0;
    saveState();
    await ctx.answerCbQuery('Bot locked');
    await ctx.reply('🔒 Bot locked.');
    return;
  }

  // Handle STOP_PANEL button
  if (data === 'STOP_PANEL') {
    if (!state.currentTask) {
      await ctx.answerCbQuery('No task to stop');
      return;
    }
    await ctx.answerCbQuery('Stopping task...');
    await stopCurrentTask(ctx);
    return;
  }

  // Handle PAUSE button
  if (data === 'PAUSE') {
    if (!state.currentTask || state.currentTask.status !== 'running') {
      await ctx.answerCbQuery('No running task');
      return;
    }
    await ctx.answerCbQuery('Pausing task...');
    await pauseCurrentTask(ctx);
    return;
  }

  // Handle CONTINUE:<taskId>
  if (data.startsWith('CONTINUE:')) {
    const taskId = data.split(':')[1];

    if (!isUnlocked()) {
      await ctx.answerCbQuery('Bot is locked');
      return;
    }

    if (!state.currentTask || state.currentTask.id !== taskId || state.currentTask.status !== 'paused') {
      await ctx.answerCbQuery('Task not found or not paused');
      return;
    }

    state.currentTask.continuationCount++;
    saveState();

    await ctx.answerCbQuery('Continuing task...');
    await startExecution(ctx, state.currentTask.taskText, true);
    return;
  }

  // Handle STOP:<taskId>
  if (data.startsWith('STOP:')) {
    const taskId = data.split(':')[1];

    if (!state.currentTask || state.currentTask.id !== taskId) {
      await ctx.answerCbQuery('Task not found');
      return;
    }

    await ctx.answerCbQuery('Stopping task...');
    await stopCurrentTask(ctx);
    return;
  }

  await ctx.answerCbQuery();
});

// ============================================================================
// Startup
// ============================================================================

async function main(): Promise<void> {
  console.log('Loading state...');
  loadState();

  // Ensure secret file exists
  if (!fs.existsSync(CONFIG.SECRET_FILE)) {
    const defaultPassword = 'changeme';
    fs.writeFileSync(CONFIG.SECRET_FILE, defaultPassword);
    console.log(`Created default secret file: ${CONFIG.SECRET_FILE}`);
    console.log('⚠️  Default password is "changeme". Change it!');
  }

  console.log('Configuration:');
  console.log(`  WORKDIR: ${CONFIG.WORKDIR}`);
  console.log(`  SECRET_FILE: ${CONFIG.SECRET_FILE}`);
  console.log(`  STATE_FILE: ${CONFIG.STATE_FILE}`);
  console.log(`  LOG_DIR: ${CONFIG.LOG_DIR}`);
  console.log(`  QUANTUM_MIN: ${CONFIG.QUANTUM_MIN}`);
  console.log(`  HEARTBEAT_SEC: ${CONFIG.HEARTBEAT_SEC}`);

  // Check for interrupted task and notify
  if (state.currentTask && state.currentTask.status === 'paused') {
    console.log('Found interrupted task, will notify user...');
    setTimeout(async () => {
      try {
        const statusText = buildStatusText(state.currentTask!);
        const msg = await bot.telegram.sendMessage(
          state.currentTask!.chatId,
          statusText + '\n\n⚠️ **Bot restarted.** Task was interrupted.\nContinue or stop?',
          { parse_mode: 'Markdown', ...getPausedKeyboard(state.currentTask!.id) }
        );
        state.currentTask!.statusMsgId = msg.message_id;
        saveState();
      } catch (err) {
        console.error('Failed to notify about interrupted task:', err);
      }
    }, 2000);
  }

  console.log('Setting up bot menu...');

  // Clear menu for all other users
  await bot.telegram.setMyCommands([], { scope: { type: 'default' } });

  // Set menu only for allowed user
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Show status and control panel' },
    { command: 'unlock', description: 'Unlock bot with password' },
    { command: 'lock', description: 'Lock bot immediately' },
    { command: 'run', description: 'Start a new task' },
    { command: 'status', description: 'Show current task status' },
    { command: 'continue', description: 'Continue paused task' },
    { command: 'pause', description: 'Pause running task' },
    { command: 'stop', description: 'Stop current task' },
    { command: 'cancel', description: 'Cancel task immediately' },
  ], { scope: { type: 'chat', chat_id: CONFIG.ALLOWED_USER_ID } });

  console.log('Starting bot...');
  await bot.launch();
  console.log('Bot is running!');

  // Graceful shutdown
  process.once('SIGINT', () => {
    console.log('Received SIGINT, stopping...');
    stopTimers();
    if (currentProcess) {
      currentProcess.kill('SIGTERM');
    }
    saveState();
    bot.stop('SIGINT');
  });

  process.once('SIGTERM', () => {
    console.log('Received SIGTERM, stopping...');
    stopTimers();
    if (currentProcess) {
      currentProcess.kill('SIGTERM');
    }
    saveState();
    bot.stop('SIGTERM');
  });
}

main().catch(console.error);
