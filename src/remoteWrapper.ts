import { AsyncLocalStorage } from 'node:async_hooks';
import { getAuthSession, requireAuth, UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import { google, docs_v1, drive_v3, sheets_v4, script_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { logger } from './logger.js';

export interface RequestClients {
  auth: OAuth2Client;
  docs: docs_v1.Docs;
  sheets: sheets_v4.Sheets;
  drive: drive_v3.Drive;
  script: script_v1.Script;
}

export const requestClients = new AsyncLocalStorage<RequestClients>();

const allowedDomains = (process.env.ALLOWED_DOMAINS || '').split(',').filter(Boolean);
const domainCache = new Map<string, boolean>();

async function checkDomain(accessToken: string): Promise<boolean> {
  if (allowedDomains.length === 0) return true;
  const cached = domainCache.get(accessToken);
  if (cached !== undefined) return cached;

  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const { hd } = await res.json();
  const allowed = allowedDomains.includes(hd);
  domainCache.set(accessToken, allowed);
  setTimeout(() => domainCache.delete(accessToken), 3_600_000);
  return allowed;
}

function createClients(accessToken: string): RequestClients {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: accessToken });
  return {
    auth,
    docs: google.docs({ version: 'v1', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
    script: google.script({ version: 'v1', auth }),
  };
}

type AddToolArg = Parameters<FastMCP['addTool']>[0];

/**
 * Wraps server.addTool() so that in remote (httpStream) mode every tool
 * automatically gets: auth enforcement, domain restriction, and per-request
 * Google API clients via AsyncLocalStorage. Zero changes to tool files.
 */
export function wrapServerForRemote(server: FastMCP): void {
  const previousAddTool = server.addTool.bind(server);

  (server as unknown as { addTool: (tool: AddToolArg) => void }).addTool = (
    toolDef: AddToolArg
  ) => {
    const originalExecute = toolDef.execute;
    previousAddTool({
      ...toolDef,
      canAccess: requireAuth,
      execute: async (args: any, context: any) => {
        const { accessToken } = getAuthSession(context.session);

        if (!(await checkDomain(accessToken))) {
          throw new UserError('Your Google account domain is not allowed on this server.');
        }

        const clients = createClients(accessToken);
        return requestClients.run(clients, () => originalExecute(args, context));
      },
    });
  };

  if (allowedDomains.length > 0) {
    logger.info(`Remote mode: domain restriction active for [${allowedDomains.join(', ')}]`);
  }
}
