import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getDriveClient } from '../../clients.js';

export const WORKSPACE_EXPORT_DEFAULTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.drawing': 'image/png',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
};

export const EXPORT_MIME_TO_EXTENSION: Record<string, string> = {
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'application/vnd.google-apps.script+json': '.json',
};

const MAX_TEXT_EXTRACT_BYTES = 50_000;

export function isTextMimeType(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/vnd.google-apps.script+json'
  );
}

function isWorkspaceMimeType(mime: string): boolean {
  return mime.startsWith('application/vnd.google-apps.');
}

const DownloadFileParameters = z.object({
  fileId: z.string().describe('The file ID from a Google Drive URL or previous tool result.'),
  savePath: z
    .string()
    .optional()
    .describe(
      'Local file path to save the downloaded file to. Parent directories are created automatically. ' +
        "If omitted, saves to the current working directory using the file's original name " +
        '(with an appropriate extension for exported Google Workspace files).'
    ),
  exportMimeType: z
    .string()
    .optional()
    .describe(
      'For Google Workspace files only: the MIME type to export as. ' +
        'E.g. "text/markdown", "application/pdf", "text/csv". ' +
        'Defaults: Docs->text/markdown, Sheets->text/csv, Slides->text/plain, Drawings->image/png.'
    ),
  extractText: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'If true, return text content in the response (up to 50KB) alongside saving the file. ' +
        'Works for text/*, application/json. For binary files, only the save path is returned.'
    ),
});

export function register(server: FastMCP) {
  server.addTool({
    name: 'downloadFile',
    description:
      'Downloads any file from Google Drive to a local path. ' +
      'For Google Workspace files (Docs, Sheets, Slides), exports to a specified format ' +
      '(defaults to text/markdown for Docs, text/csv for Sheets). ' +
      'For regular files (PDFs, images, etc.), downloads the raw bytes. ' +
      'Optionally extracts and returns text content for text-based files.',
    parameters: DownloadFileParameters,
    execute: async (args, { log }) => {
      const drive = await getDriveClient();
      log.info(`Downloading file ${args.fileId}${args.savePath ? ` to ${args.savePath}` : ''}`);

      let resolvedSavePath = args.savePath;

      try {
        // 1. Get file metadata
        const metadataRes = await drive.files.get({
          fileId: args.fileId,
          fields: 'name,mimeType,size',
          supportsAllDrives: true,
        });

        const fileName = metadataRes.data.name || 'download';
        const originalMimeType = metadataRes.data.mimeType || 'application/octet-stream';
        const isWorkspace = isWorkspaceMimeType(originalMimeType);

        // 2. Resolve export MIME type for Workspace files
        let exportMime: string | undefined;
        if (isWorkspace) {
          exportMime = args.exportMimeType || WORKSPACE_EXPORT_DEFAULTS[originalMimeType];
          if (!exportMime) {
            const shortType = originalMimeType.replace('application/vnd.google-apps.', '');
            throw new UserError(
              `Unsupported Google Workspace type "${shortType}". ` +
                `Provide an exportMimeType parameter to specify the desired export format.`
            );
          }
        }

        // 3. Resolve savePath
        if (!resolvedSavePath) {
          if (isWorkspace && exportMime) {
            const baseName = path.parse(fileName).name;
            const ext = EXPORT_MIME_TO_EXTENSION[exportMime] || '';
            resolvedSavePath = path.join(process.cwd(), baseName + ext);
          } else {
            resolvedSavePath = path.join(process.cwd(), fileName);
          }
        }

        // 4. Ensure parent directories exist
        fs.mkdirSync(path.dirname(resolvedSavePath), { recursive: true });

        // 5. Download or export
        let outputMime: string;
        if (isWorkspace && exportMime) {
          log.info(`Exporting Workspace file as ${exportMime}`);
          const res = await drive.files.export(
            { fileId: args.fileId, mimeType: exportMime },
            { responseType: 'stream' }
          );
          await pipeline(res.data as any, fs.createWriteStream(resolvedSavePath));
          outputMime = exportMime;
        } else {
          log.info(`Downloading blob file`);
          const res = await drive.files.get(
            { fileId: args.fileId, alt: 'media', supportsAllDrives: true },
            { responseType: 'stream' }
          );
          await pipeline(res.data as any, fs.createWriteStream(resolvedSavePath));
          outputMime = originalMimeType;
        }

        // 6. Get file size
        const sizeBytes = fs.statSync(resolvedSavePath).size;

        // 7. Text extraction
        let textContent: string | undefined;
        if (args.extractText !== false && isTextMimeType(outputMime)) {
          try {
            const raw = fs.readFileSync(resolvedSavePath, 'utf-8');
            textContent = raw.slice(0, MAX_TEXT_EXTRACT_BYTES);
          } catch {
            log.warn?.(`Could not read text from ${resolvedSavePath}`);
          }
        }

        // 8. Build response
        const result: Record<string, unknown> = {
          savedTo: resolvedSavePath,
          fileName,
          originalMimeType,
          sizeBytes,
        };
        if (isWorkspace && exportMime) {
          result.exportedAs = exportMime;
        }
        if (textContent !== undefined) {
          result.textContent = textContent;
        }

        return JSON.stringify(result, null, 2);
      } catch (error: any) {
        // Clean up partial file on error
        if (resolvedSavePath) {
          try {
            fs.unlinkSync(resolvedSavePath);
          } catch {
            // File may not exist yet, ignore
          }
        }

        log.error(`Error downloading file ${args.fileId}: ${error.message || error}`);
        if (error instanceof UserError) throw error;
        if (error.code === 404)
          throw new UserError(`File not found (ID: ${args.fileId}). Check the file ID.`);
        if (error.code === 403)
          throw new UserError(
            `Permission denied for file ${args.fileId}. Ensure the authenticated user has access.`
          );
        throw new UserError(`Failed to download file: ${error.message || 'Unknown error'}`);
      }
    },
  });
}
