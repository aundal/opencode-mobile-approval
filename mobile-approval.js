import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// -----------------------------------------------------------
// --- Settings ---
// VIGTIGT: ntfy.sh-kanaler er offentlige. Vælg DINE EGNE lange, tilfældige og
// hemmelige kanalnavne, og del dem ikke. Enhver der kender navnet kan se dine
// notifikationer og svare på dem. Skift de to navne herunder ud.
const NTFY_ANMODNING = "opencode-CHANGE-ME-xxxxxxxxxxxx";      // Kanal app'en abonnerer på (anmodninger ud).
const NTFY_SVAR = "opencode-CHANGE-ME-xxxxxxxxxxxx-svar";      // Kanal til svar fra app'en (svar ind).
const LOG_FILE = path.join(os.tmpdir(), "opencode-mobile-approval.log");
const NTFY_ICON_URL = "https://ubrugeligt.dk/opencode/opencode-logo-light-square.png";
const DEBUG = true;

// --- Adfærd for færdig-/fejl-notifikationer ---
const REMINDER_TIMEOUT_SECONDS = 60;         // Timeout før der sendes hvis der ingen aktivitet er i opencode.
const ACTIVE_THRESHOLD_SECONDS = 30;         // Antal sekunders inaktivitet før du regnes som "væk" fra computeren.
const NOTIFY_DONE_WHEN_INACTIVE_ONLY = true; // "Opgave udført" sendes kun når du IKKE er aktiv.
const IDLE_DEBOUNCE_MS = 1500;               // Slår dublerede session.idle-hændelser sammen.
const SUPPRESS_ON_ABORT = true;              // Undlad notificationer, hvis du selv aborter prompten (esc).

// --- Rydning af notifikationer ---
const CLEAR_NOTIFICATIONS_ON_ACTIVITY = true; // Ryd sendte telefon-notifikationer når du er aktiv i OpenCode igen.
const CLEAR_ON_ACTIVITY_DEBOUNCE_MS = 1000;   // Mindste tid (ms) mellem clear-bølger ved aktivitet.

// --- Begivenheder ---
// - "permission.asked" (Telefon-godkendelse efter timer)
// - "session.idle" (OpenCode er FÆRDIG med sit arbejde og klar til input)
// - "session.error" (Der opstod en fejl undervejs)
const NOTIFY_EVENTS = ["permission.asked", "session.idle", "session.error"];
// -----------------------------------------------------------

// PowerShell-script (Windows):
// Sekunder siden sidste tastatur/mus-input via Win32 GetLastInputInfo.
const PS_IDLE_SCRIPT = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class II { [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref L p); [StructLayout(LayoutKind.Sequential)] public struct L { public uint cbSize; public uint dwTime; } }
"@
$l = New-Object II+L
$l.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($l)
[void][II]::GetLastInputInfo([ref]$l)
[Console]::WriteLine([int]((([uint32][Environment]::TickCount) - $l.dwTime) / 1000))`;

// Hjælpefunktion til at skrive logbeskeder til en fil
function logToFile(msg) {
  if(!DEBUG)
    return;

  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
  } catch (e) {
    // Ignorer lydløst
  }
}

function encodeHeaderValue(value) {
  return /[^\x20-\x7E]/.test(value)
    ? `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
    : value;
}

// Logger HTTP-status + alle response-headers fra et ntfy-svar (til fejlsøgning).
// Ved ikke-OK svar logges også selve fejl-body'en.
async function logNtfyResponse(label, res) {
  try {
    const headerObj = {};
    if (res && res.headers && typeof res.headers.forEach === "function") {
      res.headers.forEach((v, k) => { headerObj[k] = v; });
    }
    const status = res ? `${res.status} ${res.statusText || ""}`.trim() : "intet svar";
    logToFile(`[${label}] HTTP ${status} | headers: ${JSON.stringify(headerObj)}`);
    if (res && res.ok === false) {
      let bodyText = "";
      try { bodyText = await res.text(); } catch (e) {}
      logToFile(`[${label}] Ikke-OK body: ${String(bodyText).slice(0, 800)}`);
    }
  } catch (e) {
    logToFile(`[${label}] Kunne ikke logge response: ${e.message}`);
  }
}

// ntfy sequence IDs må kun indeholde [-_A-Za-z0-9] og højst være 64 tegn.
// Ellers afviser ntfy HELE beskeden med HTTP 400 ("sequence ID invalid").
function ntfySeqId(raw) {
  const cleaned = String(raw).replace(/[^-_A-Za-z0-9]/g, "_");
  if (cleaned.length <= 64) return cleaned;
  // For lang -> deterministisk forkortelse (stabil, så clear stadig matcher).
  let h = 0;
  for (let i = 0; i < cleaned.length; i++) h = (Math.imul(h, 31) + cleaned.charCodeAt(i)) >>> 0;
  return (cleaned.slice(0, 55) + "_" + h.toString(36)).slice(0, 64);
}

export const MobileApprovalPlugin = async ({ client }) => {
  logToFile("Plugin indlæst og startet.");

  // Vi gemmer de aktive timere her, så vi kan slette dem, hvis der svares lokalt.
  // Værdi: { timer, sessionID }
  const activeReminders = new Map();

  // Tidsstempel for sidste brugeraktivitet i OpenCode (fallback til inaktivitetstjek)
  let lastInteractionTs = Date.now();

  // sessionID -> tidspunkt (ms) indtil "Opgave udført" undertrykkes (efter abort/fejl)
  const suppressDoneUntil = new Map();

  // Global undertrykkelse, hvis en hændelse mangler sessionID
  let suppressDoneGlobalUntil = 0;

  // sessionID -> sidst behandlede session.idle (til debounce af dubletter)
  const lastIdleHandledTs = new Map();

  // sessionID -> timer for udsat "done", hvis session.idle kom før idle-threshold var nået
  const pendingDoneTimers = new Map();

  // Returnerer sekunder siden sidste brugerinput.
  // OS-niveau på Windows (GetLastInputInfo) og macOS (IOHIDSystem).
  // Fejl/andre platforme: fallback til sidste OpenCode-interaktion.
  async function getIdleSeconds() {
    try {
      // Windows
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", PS_IDLE_SCRIPT],
          { timeout: 4000, windowsHide: true }
        );
        const n = parseInt(String(stdout).trim(), 10);
        if (!Number.isNaN(n)) return n;
      // OSX
      } else if (process.platform === "darwin") {
        const { stdout } = await execFileAsync(
          "/bin/sh",
          ["-c", "ioreg -c IOHIDSystem | awk '/HIDIdleTime/{print int($NF/1000000000); exit}'"],
          { timeout: 4000 }
        );
        const n = parseInt(String(stdout).trim(), 10);
        if (!Number.isNaN(n)) return n;
      }
    } catch (e) {
      logToFile(`OS-idle kunne ikke måles (${e.message}). Falder tilbage til OpenCode-interaktion.`);
    }
    return Math.floor((Date.now() - lastInteractionTs) / 1000);
  }

  // --- Rydning af allerede sendte telefon-notifikationer ---------------------
  // Holder styr på notifikationer vi har sendt, så de kan clears igen via ntfy.
  // sequence_id -> { kind: "permission"|"done"|"error"|"status", sessionID }
  const activeNotifications = new Map();
  let lastClearOnActivityTs = 0;

  // Beder ntfy om at fjerne (dismiss/mark-as-read) en allerede sendt notifikation.
  // Prøver op til 3 gange før den giver op (så den kan forsøges igen senere).
  async function clearNotification(sequenceID) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`https://ntfy.sh/${NTFY_ANMODNING}/${encodeURIComponent(sequenceID)}/clear`, {
          method: "PUT",
        });
        await logNtfyResponse(`clear ${sequenceID}`, res);
        if (!res || res.ok === undefined || res.ok) {
          activeNotifications.delete(sequenceID);
          logToFile(`Notifikation cleared: ${sequenceID} (forsøg ${attempt}/3).`);
          return true;
        }
        logToFile(`Clear gav ikke-OK svar for ${sequenceID} (forsøg ${attempt}/3).`);
      } catch (err) {
        logToFile(`Clear fejlede for ${sequenceID} (forsøg ${attempt}/3): ${err.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 250));
    }
    logToFile(`Gav op med at clear ${sequenceID} efter 3 forsøg. Beholdes til næste forsøg.`);
    return false;
  }

  // Clearer alle aktive notifikationer (fx når brugeren er aktiv i OpenCode igen).
  async function clearAllNotifications(reason) {
    const ids = [...activeNotifications.keys()];
    if (ids.length === 0) return;
    logToFile(`Clearer ${ids.length} notifikation(er). Årsag: ${reason}.`);
    for (const seq of ids) {
      await clearNotification(seq);
    }
  }

  async function sendDoneNotification(sessionID) {
    let sessionTitle = "OpenCode";
    if (sessionID) {
      try {
        const sessionRes = await client.session.get({
          path: { id: sessionID }
        });
        const session = sessionRes.data ?? sessionRes;
        if (session && session.title) {
          sessionTitle = session.title;
        }
      } catch (e) {}
    }

    const doneSeq = ntfySeqId(`done-${sessionID || "global"}`);
    const doneBody = `Af: ${sessionTitle}`;
    logToFile(`done payload. Session=${sessionID || "(mangler)"} seq=${doneSeq} title=${encodeHeaderValue('Opgave udført!')} body=${JSON.stringify(doneBody)}`);
    try {
      const doneRes = await fetch(`https://ntfy.sh/${NTFY_ANMODNING}`, {
        method: 'POST',
        headers: {
          'Title': encodeHeaderValue('Opgave udført!'),
          'Priority': 'high',
          'Tags': 'heavy_check_mark,robot_face',
          'X-Icon': NTFY_ICON_URL,
          'X-Sequence-ID': doneSeq
        },
        body: doneBody
      });
      await logNtfyResponse("done", doneRes);
      activeNotifications.set(doneSeq, { kind: "done", sessionID });
    } catch (err) {
      logToFile(`Kunne ikke sende færdig-notifikation: ${err.message}`);
    }
  }

  // NFTY-listener
  async function startNFTYListener() {
    while (true) {
      try {
        const response = await fetch(`https://ntfy.sh/${NTFY_SVAR}/json`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;
            
            let data = null;
            try {
              data = JSON.parse(line);
            } catch (jsonErr) {
              continue; // Ignorer keepalives
            }
            
            if (data && data.event === "message") {
              try {
                const messageText = (data.message || "").trim().toLowerCase();

                // Status-kommando
                // Gå aktivt ind i NTFY_SVAR og send "status".
                if (messageText === "status") {
                  logToFile("Status-anmodning modtaget fra telefonen.");
                  
                  let statusBody = "🟢 OpenCode-plugin er online og aktiv!\n\n";

                  try {
                    const sessionsRes = await client.session.list();
                    const sessions = sessionsRes.data ?? sessionsRes;
                    if (Array.isArray(sessions) && sessions.length > 0) {
                      statusBody += `Aktive sessioner (${sessions.length}):\n`;
                      sessions.forEach(s => {
                        statusBody += `- ${s.title || 'Uden navn'} (${s.id.slice(0, 8)})\n`;
                      });
                    } else {
                      statusBody += "Ingen aktive sessioner lige nu.\n";
                    }
                  } catch (err) {
                    statusBody += `Kunne ikke hente sessionsliste: ${err.message}\n`;
                  }

                  if (activeReminders.size > 0) {
                    statusBody += `\n⚠️ Der afventes svar på ${activeReminders.size} tilladelse(r) lige nu!`;
                  } else {
                    statusBody += `\n✅ Ingen afventende tilladelser i øjeblikket.`;
                  }

                  const statusSeq = ntfySeqId("status-global");
                  const statusRes = await fetch(`https://ntfy.sh/${NTFY_ANMODNING}`, {
                    method: 'POST',
                    headers: {
                      'Title': encodeHeaderValue('Systemstatus: OpenCode'),
                      'Priority': 'default',
                      'Tags': 'chart_with_upwards_trend,computer',
                      'X-Icon': NTFY_ICON_URL,
                      'X-Sequence-ID': statusSeq
                    },
                    body: statusBody
                  });
                  await logNtfyResponse("status", statusRes);
                  activeNotifications.set(statusSeq, { kind: "status" });

                  logToFile("Statusopdatering sendt succesfuldt til telefonen.");
                  continue; 
                }

                // Standard tilladelsessvar-logik
                const [choice, sessionID, permissionId] = data.message.split(":");
                logToFile(`Svar modtaget: Choice=${choice}, Session=${sessionID}, ID=${permissionId}`);

                if (choice && sessionID && permissionId) {
                  const reminder = activeReminders.get(permissionId);
                  if (reminder) {
                    clearTimeout(reminder.timer);
                    activeReminders.delete(permissionId);
                  }

                  logToFile(`Sender svar internt i hukommelsen til OpenCode...`);

                  await client.postSessionIdPermissionsPermissionId({
                    path: {
                      id: sessionID,
                      permissionID: permissionId
                    },
                    body: {
                      response: choice
                    }
                  });

                  logToFile(`Svar afleveret direkte i hukommelsen.`);
                }
              } catch (apiErr) {
                logToFile(`Fejl ved behandling af ntfy-besked: ${apiErr.message}`);
              }
            }
          }
        }
      } catch (err) {
        logToFile(`Forbindelsesfejl mod ntfy-skyen: ${err.message}. Genforbinder om 3 sekunder...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  startNFTYListener();

  return {
    event: async ({ event }) => {
      if (!event) return;

      const props = event.properties || {};
      const sessionID = props.sessionID || props.sessionId;

      // OpenCode brugeraktivitet (fallback)
      if (
        event.type === "tui.prompt.append" ||
        event.type === "tui.command.execute" ||
        event.type === "permission.replied" ||
        (event.type === "message.updated" && props.info && props.info.role === "user")
      ) {
        lastInteractionTs = Date.now();

        // Brugeren blev aktiv før en udsat done blev sendt -> annuller den.
        for (const [doneSessionID, timer] of pendingDoneTimers) {
          clearTimeout(timer);
          pendingDoneTimers.delete(doneSessionID);
          logToFile(`Annullerede udsat færdig-notifikation pga. aktivitet. Session=${doneSessionID}`);
        }

        // Brugeren er aktiv i OpenCode igen -> ryd alle sendte telefon-notifikationer.
        // Throttles, så hurtig tastning ikke spammer ntfy med clear-kald.
        if (CLEAR_NOTIFICATIONS_ON_ACTIVITY) {
          const nowTs = Date.now();
          if (nowTs - lastClearOnActivityTs >= CLEAR_ON_ACTIVITY_DEBOUNCE_MS) {
            lastClearOnActivityTs = nowTs;
            clearAllNotifications(`aktivitet (${event.type})`).catch(() => {});
          }
        }
      }

      // Brugeren svarer i terminalen:
      // Vi rydder timeren, når der svares lokalt på computeren.
      if (event.type === 'permission.replied') {
        const id = props.requestID || props.id || props.permissionID;
        if (id) {
          const reminder = activeReminders.get(id);
          if (reminder) {
            clearTimeout(reminder.timer);
            activeReminders.delete(id);
            logToFile(`Brugeren svarede lokalt. Annullerede timeren for ID: ${id}. Ingen besked sendt til telefon.`);
          }
          // Hvis permission-notifikationen allerede ER sendt, så clear den nu.
          if (sessionID) {
            const seq = ntfySeqId(`perm-${id}`);
            if (activeNotifications.has(seq)) {
              clearNotification(seq).catch(() => {});
            }
          }
        }
        return; 
      }

      // Send kun push-notifikationer for de begivenheder, der er valgt i NOTIFY_EVENTS.
      if (!NOTIFY_EVENTS.includes(event.type)) {
        return;
      }

      // 1. OpenCode beder om tilladelse (Med delay-timer)
      if (event.type === 'permission.asked') {
        const id = props.requestID || props.id || props.permissionID;
        if (!id || !sessionID) return;

        const metadata = props.metadata || {};

        const reminderTimer = setTimeout(async () => {
          logToFile(`Brugeren har ikke reageret inden for ${REMINDER_TIMEOUT_SECONDS} sekunder. Sender notifikation for ID: ${id}`);
          
          let sessionTitle = "OpenCode";
          try {
            const sessionRes = await client.session.get({
              path: { id: sessionID }
            });
            const session = sessionRes.data ?? sessionRes;
            if (session && session.title) {
              sessionTitle = session.title;
            }
          } catch (e) {
            logToFile(`Kunne ikke hente sessionsnavn: ${e.message}`);
          }

          let pathText = "ukendt placering";
          if (props.patterns && Array.isArray(props.patterns) && props.patterns.length > 0) {
            pathText = props.patterns.join(", ");
          } else if (metadata.directory) {
            pathText = metadata.directory;
          } else if (metadata.path) {
            pathText = metadata.path;
          } else if (metadata.pattern) {
            pathText = metadata.pattern;
          } else if (props.args) {
            pathText = props.args.path || props.args.directory || props.args.pattern || JSON.stringify(props.args);
          }

          const permissionType = props.permission || "";
          let permissionLabel = "Andet";
          if (permissionType === "external_directory" || permissionType === "directory") {
            permissionLabel = "Adgang";
          } else if (permissionType === "read_file") {
            permissionLabel = "Læsning";
          } else if (permissionType === "write_file" || permissionType === "edit") {
            permissionLabel = "Redigering";
          } else if (permissionType === "bash") {
            permissionLabel = "Kommando";
          }

          const commandText = `Til: ${pathText}\nAf: ${sessionTitle}`;

          const permSeq = ntfySeqId(`perm-${id}`);
          try {
            const permRes = await fetch(`https://ntfy.sh/${NTFY_ANMODNING}`, {
              method: 'POST',
              headers: {
                'Title': encodeHeaderValue(`OpenCode: ${permissionLabel}`),
                'Priority': 'high',
                'Tags': 'warning,robot_face',
                'X-Icon': NTFY_ICON_URL,
                'X-Sequence-ID': permSeq,
                'X-Actions': [
                  `http, Tillad, https://ntfy.sh/${NTFY_SVAR}, method=POST, body=once:${sessionID}:${id}, clear=true`,
                  `http, Afvis, https://ntfy.sh/${NTFY_SVAR}, method=POST, body=reject:${sessionID}:${id}, clear=true`
                ].join('; ')
              },
              body: commandText
            });
            await logNtfyResponse("permission", permRes);
            activeNotifications.set(permSeq, { kind: "permission", sessionID });
          } catch (err) {
            logToFile(`Kunne ikke sende push-notifikation: ${err.message}`);
          }
        }, REMINDER_TIMEOUT_SECONDS * 1000);

        activeReminders.set(id, { timer: reminderTimer, sessionID });
        logToFile(`Oprettet timer på ${REMINDER_TIMEOUT_SECONDS} sekunder for ID: ${id}. Venter med at sende notifikation.`);
      } 

      // 2. OpenCode er færdig med sit arbejde (session.idle)
      else if (event.type === 'session.idle') {
        const now = Date.now();
        logToFile(`session.idle modtaget. Session=${sessionID || "(mangler)"} now=${now}`);

        // Debounce: session.idle fyrer ofte flere gange på få ms.
        const lastHandled = sessionID ? (lastIdleHandledTs.get(sessionID) || 0) : 0;
        if (now - lastHandled < IDLE_DEBOUNCE_MS) {
          logToFile(`session.idle ignoreret (debounce). Session=${sessionID}`);
          return;
        }
        if (sessionID) lastIdleHandledTs.set(sessionID, now);

        // Undertryk "udført" lige efter en abort eller en ægte fejl.
        const suppressedBySession = sessionID && (suppressDoneUntil.get(sessionID) || 0) > now;
        if (suppressedBySession || suppressDoneGlobalUntil > now) {
          if (sessionID) suppressDoneUntil.delete(sessionID);
          logToFile(`Færdig-notifikation undertrykt (abort/fejl). Session=${sessionID}`);
          return;
        }

        // Send kun "udført", når brugeren ikke er aktiv ved maskinen.
        if (NOTIFY_DONE_WHEN_INACTIVE_ONLY) {
          const idle = await getIdleSeconds();
          logToFile(`session.idle vurdering. Session=${sessionID || "(mangler)"} idle=${idle}s threshold=${ACTIVE_THRESHOLD_SECONDS}s notifyWhenInactiveOnly=${NOTIFY_DONE_WHEN_INACTIVE_ONLY}`);
          if (idle < ACTIVE_THRESHOLD_SECONDS) {
            const delayMs = (ACTIVE_THRESHOLD_SECONDS - idle) * 1000;
            if (sessionID) {
              const existing = pendingDoneTimers.get(sessionID);
              if (existing) clearTimeout(existing);
              const timer = setTimeout(async () => {
                pendingDoneTimers.delete(sessionID);
                const retriedIdle = await getIdleSeconds();
                logToFile(`session.idle forsinket revurdering. Session=${sessionID} idle=${retriedIdle}s threshold=${ACTIVE_THRESHOLD_SECONDS}s`);
                if (retriedIdle < ACTIVE_THRESHOLD_SECONDS) {
                  logToFile(`Bruger er stadig aktiv ved udsat færdig-notifikation (${retriedIdle}s < ${ACTIVE_THRESHOLD_SECONDS}s). Sender IKKE færdig-notifikation.`);
                  return;
                }
                logToFile(`Bruger er nu inaktiv ved udsat færdig-notifikation (${retriedIdle}s ≥ ${ACTIVE_THRESHOLD_SECONDS}s). Sender færdig-notifikation.`);
                await sendDoneNotification(sessionID);
              }, delayMs);
              pendingDoneTimers.set(sessionID, timer);
            }
            logToFile(`Bruger er aktiv (${idle}s < ${ACTIVE_THRESHOLD_SECONDS}s). Planlægger færdig-notifikation om ${Math.ceil(delayMs / 1000)}s.`);
            return;
          }
          logToFile(`Bruger inaktiv (${idle}s ≥ ${ACTIVE_THRESHOLD_SECONDS}s). Sender færdig-notifikation.`);
        } else {
          logToFile(`OpenCode er færdig (session.idle). Sender færdig-notifikation.`);
        }
        await sendDoneNotification(sessionID);
      }

      // 3. Der skete en fejl under kørslen (session.error)
      else if (event.type === 'session.error') {
        const isAbort = props.error && props.error.name === "MessageAbortedError";

        // Når man selv annullerer (Esc), sendes der ingen notifikation.
        if (isAbort && SUPPRESS_ON_ABORT) {
          logToFile(`Bruger annullerede selv (MessageAbortedError). Ingen notifikation. Session=${sessionID}`);
          suppressDoneGlobalUntil = Date.now() + 2000; // undertryk den efterfølgende session.idle
          if (sessionID) {
            suppressDoneUntil.set(sessionID, Date.now() + 2000);
            const pendingDone = pendingDoneTimers.get(sessionID);
            if (pendingDone) {
              clearTimeout(pendingDone);
              pendingDoneTimers.delete(sessionID);
              logToFile(`Annullerede udsat færdig-notifikation pga. annullering. Session=${sessionID}`);
            }
            // Ryd evt. ventende permission-timers for samme session.
            for (const [pid, r] of activeReminders) {
              if (r.sessionID === sessionID) {
                clearTimeout(r.timer);
                activeReminders.delete(pid);
                logToFile(`Ryddede ventende permission-timer ${pid} pga. annullering.`);
              }
            }
            // Clear også evt. allerede SENDTE permission-notifikationer for sessionen.
            for (const [seq, info] of [...activeNotifications]) {
              if (info.kind === "permission" && info.sessionID === sessionID) {
                clearNotification(seq).catch(() => {});
              }
            }
          }
          return;
        }

        // Ægte fejl: undertryk den "udført", der ellers fyrer lige efter.
        suppressDoneGlobalUntil = Date.now() + 2000;
        if (sessionID) {
          suppressDoneUntil.set(sessionID, Date.now() + 2000);
          const pendingDone = pendingDoneTimers.get(sessionID);
          if (pendingDone) {
            clearTimeout(pendingDone);
            pendingDoneTimers.delete(sessionID);
            logToFile(`Annullerede udsat færdig-notifikation pga. fejl. Session=${sessionID}`);
          }
        }
        logToFile(`Der opstod en fejl i sessionen (session.error). Sender fejl-notifikation.`);

        let sessionTitle = "OpenCode";
        if (sessionID) {
          try {
            const sessionRes = await client.session.get({
              path: { id: sessionID }
            });
            const session = sessionRes.data ?? sessionRes;
            if (session && session.title) {
              sessionTitle = session.title;
            }
          } catch (e) {}
        }

        const errorSeq = ntfySeqId(`error-${sessionID || "global"}`);
        try {
          const errorRes = await fetch(`https://ntfy.sh/${NTFY_ANMODNING}`, {
            method: 'POST',
            headers: {
              'Title': encodeHeaderValue('Der opstod en fejl!'),
              'Priority': 'high',
              'Tags': 'x,warning',
              'X-Icon': NTFY_ICON_URL,
              'X-Sequence-ID': errorSeq
            },
            body: `OpenCode stødte på en fejl under kørslen.\nAf: ${sessionTitle}`
          });
          await logNtfyResponse("error", errorRes);
          activeNotifications.set(errorSeq, { kind: "error", sessionID });
        } catch (err) {
          logToFile(`Kunne ikke sende fejl-notifikation: ${err.message}`);
        }
      }
    }
  };
};
