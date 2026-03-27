#!/usr/bin/env node

// src/index.ts
//
// Single entry point for the Google Docs MCP Server.
//
// Usage:
//   @a-bonus/google-docs-mcp          Start the MCP server (default)
//   @a-bonus/google-docs-mcp auth     Run the interactive OAuth flow
//
// Remote mode (env vars):
//   MCP_TRANSPORT=httpStream           Use Streamable HTTP instead of stdio
//   BASE_URL=https://...               Public URL for OAuth redirects
//   ALLOWED_DOMAINS=scio.cz,...        Restrict to specific Google Workspace domains

import { FastMCP, GoogleProvider } from 'fastmcp';
import {
  buildCachedToolsListPayload,
  collectToolsWhileRegistering,
  installCachedToolsListHandler,
} from './cachedToolsList.js';
import { initializeGoogleClient } from './clients.js';
import { registerAllTools } from './tools/index.js';
import { wrapServerForRemote } from './remoteWrapper.js';
import { registerLandingPage } from './landingPage.js';
import { logger } from './logger.js';

// --- Auth subcommand ---
if (process.argv[2] === 'auth') {
  const { runAuthFlow } = await import('./auth.js');
  try {
    await runAuthFlow();
    logger.info('Authorization complete. You can now start the MCP server.');
    process.exit(0);
  } catch (error: any) {
    logger.error('Authorization failed:', error.message || error);
    process.exit(1);
  }
}

// --- Server startup ---

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, _promise) => {
  logger.error('Unhandled Promise Rejection:', reason);
});

const isRemote = process.env.MCP_TRANSPORT === 'httpStream';

const server = new FastMCP({
  name: 'Ultimate Google Docs & Sheets MCP Server',
  version: '1.0.0',
  ...(isRemote && {
    auth: new GoogleProvider({
      allowedRedirectUriPatterns: ['http://localhost:*', 'https://*', 'cursor://*'],
      baseUrl: process.env.BASE_URL!,
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      scopes: [
        'openid',
        'email',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/script.external_request',
      ],
    }),
  }),
});

const registeredTools: Parameters<FastMCP['addTool']>[0][] = [];
collectToolsWhileRegistering(server, registeredTools);
if (isRemote) wrapServerForRemote(server);
registerAllTools(server);

try {
  if (isRemote) {
    logger.info('Starting in remote mode (httpStream + MCP OAuth 2.1)...');
    registerLandingPage(server, registeredTools.length);

    const port = parseInt(process.env.PORT || '8080');
    await server.start({
      transportType: 'httpStream',
      httpStream: {
        port,
        host: '0.0.0.0',
      },
    });

    logger.info(`MCP Server running at ${process.env.BASE_URL || `http://0.0.0.0:${port}`}/mcp`);
  } else {
    await initializeGoogleClient();
    logger.info('Starting Ultimate Google Docs & Sheets MCP server...');

    const cachedToolsList = await buildCachedToolsListPayload(registeredTools);
    await server.start({ transportType: 'stdio' as const });
    installCachedToolsListHandler(server, cachedToolsList);
    logger.info('MCP Server running using stdio. Awaiting client connection...');
  }
  logger.info('Process-level error handling configured to prevent crashes from timeout errors.');
} catch (startError: any) {
  logger.error('FATAL: Server failed to start:', startError.message || startError);
  process.exit(1);
}
