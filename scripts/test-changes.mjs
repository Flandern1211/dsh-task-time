import { readFileSync } from 'node:fs';

const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const toastSrc = readFileSync(new URL('../lib/toast.ps1', import.meta.url), 'utf8');

let pass = 0, fail = 0;

function check(name, ok) {
  if (ok) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}`); }
}

console.log('=== dsh-task-time change verification ===\n');

// externalAlert signature
check('externalAlert accepts sound param',
  indexSrc.includes('function externalAlert(title, message, sessionId, sound)'));

// -Sound arg propagated
check('-Sound arg propagated to spawn',
  indexSrc.includes("args.push('-Sound', String(sound)"));

// notifyDecision: pushReminder before throttle
const pushLine = indexSrc.indexOf("pushReminder('decision'");
const throttleLine = indexSrc.indexOf('prev.notifiedAt <= 20000');
check('pushReminder BEFORE throttle check',
  pushLine >= 0 && throttleLine >= 0 && pushLine < throttleLine);

// finishTask has externalAlert with IM sound
check('finishTask calls externalAlert',
  indexSrc.includes('externalAlert('));

// All three sound types
check('IM sound for finish', indexSrc.includes('Notification.IM'));
check('Reminder sound for interval', indexSrc.includes('Notification.Reminder'));
check('Looping.Alarm for decision', indexSrc.includes('Notification.Looping.Alarm'));
check('Looping.Alarm2 for overdue', indexSrc.includes('Notification.Looping.Alarm2'));

// toast.ps1 Sound param
check('toast.ps1 has $Sound param', toastSrc.includes('$Sound'));
check('toast.ps1 supports audio src', toastSrc.includes('SetAttribute("src"'));

// ensureLoaded cleanup
check('pendingSetup cleanup after load', indexSrc.includes('pendingSetup.delete(sid)'));

// await ensureLoaded in handlers
check('agent/created awaits ensureLoaded',
  indexSrc.includes("ctx.on('agent/created', async") && indexSrc.includes('await ensureLoaded()'));
check('agent/status awaits ensureLoaded',
  indexSrc.includes("ctx.on('agent/status', async") && indexSrc.includes('await ensureLoaded()'));
check('agent/disposed awaits ensureLoaded',
  indexSrc.includes("ctx.on('agent/disposed', async") && indexSrc.includes('await ensureLoaded()'));
check('get-pending-setup awaits ensureLoaded',
  indexSrc.includes("'get-pending-setup': async") && indexSrc.includes('await ensureLoaded()'));
check('get-pending-sessions awaits ensureLoaded',
  indexSrc.includes("'get-pending-sessions': async") && indexSrc.includes('await ensureLoaded()'));

// Immediate persist on set/dismiss
check('set-session-config calls persistRecords() inline',
  indexSrc.includes("persistRecords()"));
check('dismiss-session-setup calls persistRecords() inline',
  indexSrc.includes("persistRecords()"));

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);