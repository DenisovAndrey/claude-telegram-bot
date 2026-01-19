import { exec } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';

const execAsync = promisify(exec);

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export async function getDeviceStatus(): Promise<string> {
  const lines: string[] = ['📊 **Device Status**', ''];

  // Hostname & Platform
  lines.push(`🖥 **Host:** ${os.hostname()}`);
  lines.push(`💻 **Platform:** ${os.platform()} ${os.arch()}`);
  lines.push('');

  // Uptime
  const uptimeSec = os.uptime();
  const uptimeDays = Math.floor(uptimeSec / 86400);
  const uptimeHours = Math.floor((uptimeSec % 86400) / 3600);
  const uptimeMins = Math.floor((uptimeSec % 3600) / 60);
  lines.push(`⏱ **Uptime:** ${uptimeDays}d ${uptimeHours}h ${uptimeMins}m`);
  lines.push('');

  // CPU Load
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  lines.push(`⚡ **CPU:** ${cpuCount} cores`);
  lines.push(`📈 **Load:** ${loadAvg[0].toFixed(2)} / ${loadAvg[1].toFixed(2)} / ${loadAvg[2].toFixed(2)} (1/5/15 min)`);
  lines.push('');

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = ((usedMem / totalMem) * 100).toFixed(1);
  lines.push(`🧠 **Memory:** ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPercent}%)`);
  lines.push('');

  // Temperature (Raspberry Pi specific)
  try {
    const { stdout: tempOut } = await execAsync('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "N/A"');
    const tempVal = tempOut.trim();
    if (tempVal !== 'N/A' && !isNaN(parseInt(tempVal))) {
      const tempC = (parseInt(tempVal) / 1000).toFixed(1);
      lines.push(`🌡 **Temperature:** ${tempC}°C`);
      lines.push('');
    }
  } catch {
    // Temperature not available
  }

  // Disk usage
  try {
    const { stdout: dfOut } = await execAsync('df -h / | tail -1');
    const dfParts = dfOut.trim().split(/\s+/);
    if (dfParts.length >= 5) {
      lines.push(`💾 **Disk (/):** ${dfParts[2]} / ${dfParts[1]} (${dfParts[4]} used)`);
    }
  } catch {
    // df not available
  }

  // Network IP
  try {
    const { stdout: ipOut } = await execAsync("hostname -I 2>/dev/null | awk '{print $1}' || echo ''");
    const ip = ipOut.trim();
    if (ip) {
      lines.push(`🌐 **IP:** ${ip}`);
    }
  } catch {
    // hostname -I not available (macOS fallback)
    try {
      const { stdout: ipOut } = await execAsync("ipconfig getifaddr en0 2>/dev/null || echo ''");
      const ip = ipOut.trim();
      if (ip) {
        lines.push(`🌐 **IP:** ${ip}`);
      }
    } catch {
      // No IP available
    }
  }

  lines.push('');
  lines.push(`🕐 **Time:** ${new Date().toISOString()}`);

  return lines.join('\n');
}
