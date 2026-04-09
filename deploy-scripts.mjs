#!/usr/bin/env node

/**
 * Deploy Apps Script files to all Google Sheets in "Listas FINAL".
 * Bulletproof version — will keep retrying until ALL files are done.
 * Safe to leave running for hours.
 */

import { google } from 'googleapis';
import { authorize } from './dist/auth.js';
import fs from 'fs/promises';

// ── Config ──
const FOLDER_ID = '1MKRzSeecYk0vVjEtu8QbD6csb02Zc1Mo';
const DELAY_BETWEEN_FILES_MS = 30000;   // 30s between files
const INITIAL_QUOTA_WAIT_MS = 180000;   // 3 min on first quota error
const MAX_QUOTA_WAIT_MS = 600000;       // 10 min max wait
const PROGRESS_FILE = './deploy-progress.json';

const scriptListaPath = 'C:/Users/coord/Documents/Scripts/Código Lista.txt';
const scriptPlanPath = 'C:/Users/coord/Documents/Scripts/Código Planeación.txt';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function loadProgress() {
  try {
    const data = await fs.readFile(PROGRESS_FILE, 'utf-8');
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

async function saveProgress(completedIds) {
  await fs.writeFile(PROGRESS_FILE, JSON.stringify([...completedIds]));
}

function isQuotaError(msg) {
  return msg.includes('quota') || msg.includes('exhausted') || msg.includes('RESOURCE_EXHAUSTED');
}

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  NICHIBOKU BOT — Deploy to all spreadsheets`);
  console.log(`  Started: ${new Date().toLocaleString('es-MX')}`);
  console.log(`${'═'.repeat(60)}\n`);

  console.log('[' + timestamp() + '] 🔐 Authenticating...');
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const script = google.script({ version: 'v1', auth });

  // ── Read script contents ──
  let codigoLista = await fs.readFile(scriptListaPath, 'utf-8');
  const codigoPlaneacion = await fs.readFile(scriptPlanPath, 'utf-8');

  codigoLista = codigoLista.replace(/^Código Lista\s*\n+/, '');
  const codigoPlan = codigoPlaneacion.replace(/^Código Planeación\s*\n+/, '');
  codigoLista = codigoLista.replace('PEGA_AQUI_EL_ID_DE_TU_CARPETA_LISTAS_FINAL', FOLDER_ID);

  const scriptFiles = [
    { name: 'Código Lista', type: 'SERVER_JS', source: codigoLista },
    { name: 'Código Planeación', type: 'SERVER_JS', source: codigoPlan },
    {
      name: 'appsscript',
      type: 'JSON',
      source: JSON.stringify({
        timeZone: 'America/Mexico_City',
        dependencies: {},
        exceptionLogging: 'STACKDRIVER',
        runtimeVersion: 'V8',
        oauthScopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/script.external_request',
        ],
      }),
    },
  ];

  // ── List all Google Sheets in folder ──
  console.log('[' + timestamp() + '] 📂 Listing spreadsheets...');
  let allFiles = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      pageSize: 100,
      fields: 'nextPageToken, files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });
    allFiles = allFiles.concat(res.data.files || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // ── Load progress ──
  const completed = await loadProgress();
  const pending = allFiles.filter(f => !completed.has(f.id));

  console.log(`[${timestamp()}] 📋 Total: ${allFiles.length} | ✅ Done: ${completed.size} | ⏳ Pending: ${pending.length}\n`);

  if (pending.length === 0) {
    console.log('🎉 All files already deployed! Delete deploy-progress.json to re-run.');
    return;
  }

  // ── Deploy each file — NEVER give up ──
  let success = 0;
  let currentQuotaWait = INITIAL_QUOTA_WAIT_MS;

  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    const totalDone = completed.size;
    const totalLeft = allFiles.length - totalDone;
    let deployed = false;

    while (!deployed) {
      try {
        process.stdout.write(`[${timestamp()}] [${totalDone + 1}/${allFiles.length}] 📄 ${file.name}... `);

        // Step 1: Create bound script project
        const createRes = await script.projects.create({
          requestBody: { title: 'Nichiboku Bot', parentId: file.id },
        });
        const scriptId = createRes.data.scriptId;

        await sleep(2000);

        // Step 2: Upload script content
        await script.projects.updateContent({
          scriptId,
          requestBody: { files: scriptFiles },
        });

        console.log('✅');
        success++;
        completed.add(file.id);
        await saveProgress(completed);

        // Reset quota wait on success
        currentQuotaWait = INITIAL_QUOTA_WAIT_MS;
        deployed = true;

      } catch (err) {
        const msg = err.message || String(err);

        if (isQuotaError(msg)) {
          // Quota error — wait and retry (NEVER give up)
          console.log(`⏳ Quota — waiting ${Math.round(currentQuotaWait / 60000)} min...`);
          await sleep(currentQuotaWait);

          // Increase wait time (up to max), back off exponentially
          currentQuotaWait = Math.min(currentQuotaWait * 1.5, MAX_QUOTA_WAIT_MS);
        } else if (msg.includes('already has a bound script project') || msg.includes('already exists')) {
          // File already has a script — skip it
          console.log('⏭️ (already has script)');
          completed.add(file.id);
          await saveProgress(completed);
          deployed = true;
        } else {
          // Unknown error — log and skip after 3 tries
          console.log(`❌ ${msg.substring(0, 120)}`);
          // Wait a bit and retry once for non-quota errors
          await sleep(10000);
          try {
            process.stdout.write(`[${timestamp()}]   ↪ Retry... `);
            const createRes = await script.projects.create({
              requestBody: { title: 'Nichiboku Bot', parentId: file.id },
            });
            await sleep(2000);
            await script.projects.updateContent({
              scriptId: createRes.data.scriptId,
              requestBody: { files: scriptFiles },
            });
            console.log('✅');
            success++;
            completed.add(file.id);
            await saveProgress(completed);
            deployed = true;
          } catch (retryErr) {
            const retryMsg = retryErr.message || '';
            if (isQuotaError(retryMsg)) {
              console.log(`⏳ Quota on retry — waiting ${Math.round(currentQuotaWait / 60000)} min...`);
              await sleep(currentQuotaWait);
              currentQuotaWait = Math.min(currentQuotaWait * 1.5, MAX_QUOTA_WAIT_MS);
            } else {
              console.log(`❌ Skipping: ${retryMsg.substring(0, 100)}`);
              deployed = true; // Skip this file to avoid infinite loop on non-quota errors
            }
          }
        }
      }
    }

    // Wait between files (only if more pending)
    if (i < pending.length - 1 && deployed) {
      await sleep(DELAY_BETWEEN_FILES_MS);
    }
  }

  // ── Final summary ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  FINISHED: ${new Date().toLocaleString('es-MX')}`);
  console.log(`  ✅ Deployed this run: ${success}`);
  console.log(`  ✅ Total completed: ${completed.size}/${allFiles.length}`);
  const failed = allFiles.length - completed.size;
  if (failed > 0) {
    console.log(`  ⚠️ Not completed: ${failed} (run again to retry)`);
  } else {
    console.log(`  🎉 ALL FILES DONE!`);
  }
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  console.error('Run the script again — progress is saved.');
  process.exit(1);
});
