import fs from "fs";
import path from "path";
import os from "os";

// --- KONFIGURATION ---
// VIGTIGT: ntfy.sh-kanaler er offentlige. Vælg DINE EGNE lange, tilfældige og
// hemmelige kanalnavne, og del dem ikke. Enhver der kender kanalnavnet kan se
// dine notifikationer og svare på dem. Skift de to navne herunder ud.
const NTFY_ANMODNING = "opencode-CHANGE-ME-xxxxxxxxxxxx";      // Kanal app'en abonnerer på (anmodninger ud).
const NTFY_SVAR = "opencode-CHANGE-ME-xxxxxxxxxxxx-svar";      // Kanal til svar fra app'en (svar ind).
const REMINDER_TIMEOUT_SECONDS = 60;
const LOG_FILE = path.join(os.tmpdir(), "opencode-mobile-approval.log");
const NTFY_ICON_URL = "https://ubrugeligt.dk/opencode/opencode-logo-light-square.png";
const DEBUG = true;
// -----------------------------------------------------------

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

  // Vi gemmer de aktive timere her, så vi kan slette dem, hvis der svares lokalt
  const activeReminders = new Map();

  // En lynhurtig stream-lytter mod ntfy-skyen
  async function startSkyLytter() {
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
                const [choice, sessionID, permissionId] = data.message.split(":");
                logToFile(`Svar modtaget: Choice=${choice}, Session=${sessionID}, ID=${permissionId}`);

                if (choice && sessionID && permissionId) {
                  // Ryd påmindelsen hvis brugeren mod forventning svarer fra telefonen
                  const reminderId = activeReminders.get(permissionId);
                  if (reminderId) {
                    clearTimeout(reminderId);
                    activeReminders.delete(permissionId);
                  }

                  logToFile(`Sender svar internt i hukommelsen til OpenCode...`);

                  // Svar direkte i hukommelsen
                  await client.postSessionIdPermissionsPermissionId({
                    path: {
                      id: sessionID,
                      permissionID: permissionId
                    },
                    body: {
                      response: choice // "once" eller "reject"
                    }
                  });

                  logToFile(`Svar afleveret direkte i hukommelsen.`);
                }
              } catch (apiErr) {
                logToFile(`Fejl ved afsendelse af svar via in-process SDK: ${apiErr.message}`);
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

  // Start lytteren i baggrunden
  startSkyLytter();

  return {
    event: async ({ event }) => {
      // SCENARIE A: OpenCode beder om tilladelse (Venter på timeren her)
      if (event && event.type === 'permission.asked') {
        const props = event.properties || {};
        const id = props.requestID || props.id || props.permissionID;
        const sessionID = props.sessionID || props.sessionId;
        
        if (!id || !sessionID) {
          logToFile(`Manglende ID eller SessionID i hændelse: id=${id}, session=${sessionID}`);
          return;
        }

        const metadata = props.metadata || {};

        // Start timeren. Hvis brugeren ikke svarer lokalt på computeren inden for de valgte sekunder,
        // sendes der en notifikation til telefonen.
        const reminderTimer = setTimeout(async () => {
          logToFile(`Brugeren har ikke reageret inden for ${REMINDER_TIMEOUT_SECONDS} sekunder. Sender notifikation til telefonen for ID: ${id}`);
          
          // 1. Hent sessionsnavn
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

          // 2. Find stien
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

          // 3. Oversæt handling
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

          const commandText = `${handling} ${pathText}\nProject: ${sessionTitle}`;

          // 4. Send notifikationen ud
          try {
            await fetch(`https://ntfy.sh/${NTFY_ANMODNING}`, {
              method: 'POST',
              headers: {
                'Title': 'OpenCode',
                'Priority': 'high',
                'Tags': 'warning',
                'X-Icon': NTFY_ICON_URL, 
                'X-Actions': [
                  `http, Tillad, https://ntfy.sh/${NTFY_SVAR}, method=POST, body=once:${sessionID}:${id}, clear=true`,
                  `http, Afvis, https://ntfy.sh/${NTFY_SVAR}, method=POST, body=reject:${sessionID}:${id}, clear=true`
                ].join('; ')
              },
              body: commandText
            });
            logToFile(`Notifikation blev sendt succesfuldt efter timeout.`);
          } catch (err) {
            logToFile(`Kunne ikke sende push-notifikation: ${err.message}`);
          }
        }, REMINDER_TIMEOUT_SECONDS * 1000);

        // Gem timeren i vores Map
        activeReminders.set(id, reminderTimer);
        logToFile(`Oprettet timer på ${REMINDER_TIMEOUT_SECONDS} sekunder for ID: ${id}. Venter med at sende notifikation.`);
      } 
      
      // SCENARIE B: Brugeren svarede direkte i terminalen (replied)
      // Vi rydder og annullerer timeren øjeblikkeligt, så der ALDRIG sendes en besked til telefonen!
      else if (event && event.type === 'permission.replied') {
        const props = event.properties || {};
        const id = props.requestID || props.id || props.permissionID;
        
        if (id) {
          const reminderId = activeReminders.get(id);
          if (reminderId) {
            clearTimeout(reminderId);
            activeReminders.delete(id);
            logToFile(`Brugeren svarede lokalt. Annullerede timeren for ID: ${id}. Ingen besked sendt til telefon.`);
          }
        }
      }
    }
  };
};
