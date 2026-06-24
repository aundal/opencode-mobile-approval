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

                  await fetch(`https://ntfy.sh/${NTFY_ANMODNING}`, {
                    method: 'POST',
                    headers: {
                      'Title': 'Systemstatus: OpenCode',
                      'Priority': 'default',
                      'Tags': 'chart_with_upwards_trend,computer',
                      'X-Icon': NTFY_ICON_URL
                    },
                    body: statusBody
                  });

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
          let handling = "Handling på";
          if (permissionType === "external_directory" || permissionType === "directory") {
            handling = "Adgang til";
          } else if (permissionType === "read_file") {
            handling = "Læsning af";
          } else if (permissionType === "write_file" || permissionType === "edit") {
            handling = "Redigering af";
          } else if (permissionType === "bash") {
            handling = "Kørsel af kommando i";
          }

          const commandText = `${handling} ${pathText}\nAf ${sessionTitle}`;

          try {
            await fetch(`https://ntfy.sh/${NTFY_ANMODNING}`, {
              method: 'POST',
              headers: {
                'Title': 'OpenCode kræver godkendelse!',
                'Priority': 'high',
                'Tags': 'warning,robot_face',
                'X-Icon': NTFY_ICON_URL,
                'X-Actions': [
                  `http, Tillad, https://ntfy.sh/${NTFY_SVAR}, method=POST, body=once:${sessionID}:${id}, clear=true`,
                  `http, Afvis, https://ntfy.sh/${NTFY_SVAR}, method=POST, body=reject:${sessionID}:${id}, clear=true`
                ].join('; ')
              },
              body: commandText
            });
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
          if (idle < ACTIVE_THRESHOLD_SECONDS) {
            logToFile(`Bruger er aktiv (${idle}s < ${ACTIVE_THRESHOLD_SECONDS}s). Sender IKKE færdig-notifikation.`);
            return;
          }
          logToFile(`Bruger inaktiv (${idle}s ≥ ${ACTIVE_THRESHOLD_SECONDS}s). Sender færdig-notifikation.`);
        } else {
          logToFile(`OpenCode er færdig (session.idle). Sender færdig-notifikation.`);
        }

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

        try {
          await fetch(`https://ntfy.sh/${NTFY_ANMODNING}`, {
            method: 'POST',
            headers: {
              'Title': 'Opgave udført!',
              'Priority': 'default',
              'Tags': 'heavy_check_mark,robot_face',
              'X-Icon': NTFY_ICON_URL
            },
            body: `OpenCode har udført opgaven og afventer dit input.\nAf ${sessionTitle}`
          });
        } catch (err) {
          logToFile(`Kunne ikke sende færdig-notifikation: ${err.message}`);
        }
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
            // Ryd evt. ventende permission-timers for samme session.
            for (const [pid, r] of activeReminders) {
              if (r.sessionID === sessionID) {
                clearTimeout(r.timer);
                activeReminders.delete(pid);
                logToFile(`Ryddede ventende permission-timer ${pid} pga. annullering.`);
              }
            }
          }
          return;
        }

        // Ægte fejl: undertryk den "udført", der ellers fyrer lige efter.
        suppressDoneGlobalUntil = Date.now() + 2000;
        if (sessionID) suppressDoneUntil.set(sessionID, Date.now() + 2000);
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

        try {
          await fetch(`https://ntfy.sh/${NTFY_ANMODNING}`, {
            method: 'POST',
            headers: {
              'Title': 'Der opstod en fejl!',
              'Priority': 'high',
              'Tags': 'x,warning',
              'X-Icon': NTFY_ICON_URL
            },
            body: `OpenCode stødte på en fejl under kørslen.\nAf: ${sessionTitle}`
          });
        } catch (err) {
          logToFile(`Kunne ikke sende fejl-notifikation: ${err.message}`);
        }
      }
    }
  };
};