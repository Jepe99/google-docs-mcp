// src/clients.ts
import { google, docs_v1, drive_v3, sheets_v4, script_v1 } from 'googleapis';
import { UserError } from 'fastmcp';
import { OAuth2Client } from 'google-auth-library';
import { authorize } from './auth.js';
import { logger } from './logger.js';
import { requestClients } from './remoteWrapper.js';

let authClient: OAuth2Client | null = null;
let googleDocs: docs_v1.Docs | null = null;
let googleDrive: drive_v3.Drive | null = null;
let googleSheets: sheets_v4.Sheets | null = null;
let googleScript: script_v1.Script | null = null;

// --- Initialization ---
export async function initializeGoogleClient() {
  if (googleDocs && googleDrive && googleSheets)
    return { authClient, googleDocs, googleDrive, googleSheets, googleScript };
  if (!authClient) {
    try {
      logger.info('Attempting to authorize Google API client...');
      const client = await authorize();
      authClient = client;
      googleDocs = google.docs({ version: 'v1', auth: authClient });
      googleDrive = google.drive({ version: 'v3', auth: authClient });
      googleSheets = google.sheets({ version: 'v4', auth: authClient });
      googleScript = google.script({ version: 'v1', auth: authClient });
      logger.info('Google API client authorized successfully.');
    } catch (error) {
      logger.error('FATAL: Failed to initialize Google API client:', error);
      authClient = null;
      googleDocs = null;
      googleDrive = null;
      googleSheets = null;
      googleScript = null;
      throw new Error('Google client initialization failed. Cannot start server tools.');
    }
  }
  if (authClient && !googleDocs) {
    googleDocs = google.docs({ version: 'v1', auth: authClient });
  }
  if (authClient && !googleDrive) {
    googleDrive = google.drive({ version: 'v3', auth: authClient });
  }
  if (authClient && !googleSheets) {
    googleSheets = google.sheets({ version: 'v4', auth: authClient });
  }
  if (authClient && !googleScript) {
    googleScript = google.script({ version: 'v1', auth: authClient });
  }

  if (!googleDocs || !googleDrive || !googleSheets) {
    throw new Error('Google Docs, Drive, and Sheets clients could not be initialized.');
  }

  return { authClient, googleDocs, googleDrive, googleSheets, googleScript };
}

// --- Helper to get Docs client within tools ---
export async function getDocsClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.docs;
  const { googleDocs: docs } = await initializeGoogleClient();
  if (!docs) {
    throw new UserError(
      'Google Docs client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return docs;
}

// --- Helper to get Drive client within tools ---
export async function getDriveClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.drive;
  const { googleDrive: drive } = await initializeGoogleClient();
  if (!drive) {
    throw new UserError(
      'Google Drive client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return drive;
}

// --- Helper to get Sheets client within tools ---
export async function getSheetsClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.sheets;
  const { googleSheets: sheets } = await initializeGoogleClient();
  if (!sheets) {
    throw new UserError(
      'Google Sheets client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return sheets;
}

// --- Helper to get Auth client for direct API usage ---
export async function getAuthClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.auth;
  const { authClient: client } = await initializeGoogleClient();
  if (!client) {
    throw new UserError(
      'Auth client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return client;
}

// --- Helper to get Script client within tools ---
export async function getScriptClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.script;
  const { googleScript: script } = await initializeGoogleClient();
  if (!script) {
    throw new UserError(
      'Google Script client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return script;
}
