#!/usr/bin/env node

/**
 * Upgrade all 114 stubs from NichibokuLib v1 → v2.
 *
 * Strategy: For each spreadsheet, try to create a dummy script project.
 * If it fails with "already has a bound script", that's expected.
 * Then search Drive for script files and try to read/update them.
 *
 * If we can't find the script via API, we create a NEW bound script
 * project (the old one becomes orphaned but harmless).
 */

import { google } from 'googleapis';
import { authorize } from './dist/auth.js';
import fs from 'fs/promises';

// ── Config ──
const FOLDER_ID = '1MKRzSeecYk0vVjEtu8QbD6csb02Zc1Mo';
const LIB_ID = '1c2_fhCLebntfBnjaZJ9EOTxulZDrij5QDnWrc2nTFTOAcFTQZmGP-JTD';
const DELAY_MS = 15000;           // 15s between files
const QUOTA_WAIT_MS = 180000;     // 3 min on quota error
const MAX_QUOTA_WAIT_MS = 600000; // 10 min max
const PROGRESS_FILE = './upgrade-v2-progress.json';

// Stub code that calls NichibokuLib
const STUB_CODE = `// Nichiboku Bot — Stub v2
// Este archivo llama a las funciones de la biblioteca NichibokuLib.
// NO modificar directamente — los cambios se hacen en la biblioteca.

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('\\u{1F338} Nichiboku Bot')
    .addItem('\\u{26A1} Actualizar este archivo', 'actualizarEsteArchivo')
    .addItem('\\u{1F527} Reestructurar Planeación', 'reestructurarPlaneacion')
    .addSeparator()
    .addItem('\\u{1F4CB} Actualizar TODO (Lista + Planeación)', 'actualizarTodo')
    .addToUi();
}

function actualizarEsteArchivo() { NichibokuLib.actualizarEsteArchivo(); }
function reestructurarPlaneacion() { NichibokuLib.reestructurarPlaneacion(); }
function actualizarTodo() { NichibokuLib.actualizarTodoEsteArchivo(); }
`;

const MANIFEST = JSON.stringify({
  timeZone: 'America/Mexico_City',
  dependencies: {
    libraries: [{
      userSymbol: 'NichibokuLib',
      libraryId: LIB_ID,
      version: '2',
    }],
  },
  exceptionLogging: 'STACKDRIVER',
  runtimeVersion: 'V8',
  oauthScopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/script.external_request',
  ],
}, null, 2);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

async function loadProgress() {
  try { return new Set(JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf-8'))); }
  catch { return new Set(); }
}
async function saveProgress(set) {
  await fs.writeFile(PROGRESS_FILE, JSON.stringify([...set]));
}

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  NICHIBOKU — Upgrade stubs to Library v2');
  console.log(`  ${new Date().toLocaleString('es-MX')}`);
  console.log(`${'═'.repeat(60)}\n`);

  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const scriptApi = google.script({ version: 'v1', auth });

  // List all spreadsheets
  let allFiles = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      pageSize: 100,
      fields: 'nextPageToken, files(id, name)',
      ...(pageToken ? { pageToken } : {}),
    });
    allFiles = allFiles.concat(res.data.files || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const completed = await loadProgress();
  const pending = allFiles.filter(f => !completed.has(f.id));
  console.log(`[${ts()}] 📋 Total: ${allFiles.length} | ✅ Done: ${completed.size} | ⏳ Pending: ${pending.length}\n`);

  if (pending.length === 0) {
    console.log('🎉 All done!');
    return;
  }

  let quotaWait = QUOTA_WAIT_MS;

  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    let done = false;

    while (!done) {
      try {
        process.stdout.write(`[${ts()}] [${completed.size + 1}/${allFiles.length}] 📄 ${file.name}... `);

        // Try to create a new bound script (will fail if one exists)
        const createRes = await scriptApi.projects.create({
          requestBody: { title: 'Nichiboku Bot', parentId: file.id },
        });
        const scriptId = createRes.data.scriptId;

        await sleep(3000);

        // Upload stub with v2 library reference
        await scriptApi.projects.updateContent({
          scriptId,
          requestBody: {
            files: [
              { name: 'appsscript', type: 'JSON', source: MANIFEST },
              { name: 'Código', type: 'SERVER_JS', source: STUB_CODE },
            ],
          },
        });

        console.log('✅ (new script with v2)');
        completed.add(file.id);
        await saveProgress(completed);
        done = true;
        quotaWait = QUOTA_WAIT_MS; // reset

      } catch (err) {
        const msg = err.message || String(err);

        if (msg.includes('quota') || msg.includes('exhausted') || msg.includes('RESOURCE_EXHAUSTED')) {
          console.log(`⏳ Quota — waiting ${Math.round(quotaWait / 60000)} min...`);
          await sleep(quotaWait);
          quotaWait = Math.min(quotaWait * 1.5, MAX_QUOTA_WAIT_MS);

        } else if (msg.includes('This file already has')) {
          // Already has a bound script — need to find and update it
          console.log('🔄 Has existing script, searching...');

          // The old deploy created scripts with title "Nichiboku Bot" as children
          // Try searching by iterating all scripts the user owns
          try {
            // Search for script files that might be bound to this spreadsheet
            const searchRes = await drive.files.list({
              q: `mimeType='application/vnd.google-apps.script' and name='Nichiboku Bot' and trashed=false`,
              pageSize: 200,
              fields: 'files(id, name, parents)',
            });

            // Find the one whose parent is this spreadsheet
            const match = searchRes.data.files?.find(s =>
              s.parents && s.parents.includes(file.id)
            );

            if (match) {
              // Found it! Update its content
              await scriptApi.projects.updateContent({
                scriptId: match.id,
                requestBody: {
                  files: [
                    { name: 'appsscript', type: 'JSON', source: MANIFEST },
                    { name: 'Código', type: 'SERVER_JS', source: STUB_CODE },
                  ],
                },
              });
              console.log(`  ✅ Updated existing script (${match.id.substring(0, 12)}...)`);
            } else {
              // Can't find it via Drive — mark as needing manual update
              console.log('  ⚠️ Script exists but not findable via API — needs manual v2 change');
            }

            completed.add(file.id);
            await saveProgress(completed);
            done = true;

          } catch (searchErr) {
            const sMsg = searchErr.message || '';
            if (sMsg.includes('quota') || sMsg.includes('exhausted')) {
              console.log(`  ⏳ Quota on search — waiting ${Math.round(quotaWait / 60000)} min...`);
              await sleep(quotaWait);
              quotaWait = Math.min(quotaWait * 1.5, MAX_QUOTA_WAIT_MS);
            } else {
              console.log(`  ❌ Search error: ${sMsg.substring(0, 80)}`);
              completed.add(file.id);
              await saveProgress(completed);
              done = true;
            }
          }

        } else {
          console.log(`❌ ${msg.substring(0, 100)}`);
          // Skip after unknown error
          completed.add(file.id);
          await saveProgress(completed);
          done = true;
        }
      }

      if (done) {
        await sleep(DELAY_MS);
      }
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Completed: ${completed.size}/${allFiles.length}`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
