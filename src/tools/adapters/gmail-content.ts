import { createHash, randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import { ToolError } from '../types.js';
import { accountIdSchema } from './gmail-accounts.js';
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const gmailId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
export const emailSchema = z.string().trim().toLowerCase().email().max(254).refine(value => !/[\r\n\0]/.test(value));
export const attachmentRef = z.object({ accountId: accountIdSchema, messageId: gmailId, partId: z.string().regex(/^[\d.]{0,80}$/) }).strict();
export type AttachmentRef = z.infer<typeof attachmentRef>;
export interface MessagePart { partId?: string; mimeType?: string; filename?: string; headers?: Array<{ name?: string; value?: string }>; body?: { attachmentId?: string; size?: number; data?: string }; parts?: MessagePart[] }
export interface GmailMessage { id: string; threadId: string; historyId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: MessagePart; raw?: string }
export interface AttachmentMetadata extends AttachmentRef { threadId: string; filename: string; mimeType: string; size: number; attachmentId?: string }
export function messageHeaders(message: GmailMessage): Map<string, string> {
  return new Map((message.payload?.headers ?? []).filter(h => typeof h.name === 'string' && typeof h.value === 'string').map(h => [h.name!.toLowerCase(), h.value!]));
}
export function parts(message: GmailMessage): MessagePart[] {
  const result: MessagePart[] = [];
  const visit = (part: MessagePart, depth: number) => {
    if (depth > 16 || result.length >= 200) throw new ToolError('LIMIT');
    result.push(part); for (const child of part.parts ?? []) visit(child, depth + 1);
  };
  if (message.payload) visit(message.payload, 0); return result;
}
export function decodeData(data: string, limit = MAX_ATTACHMENT_BYTES): Buffer {
  if (!/^[a-zA-Z0-9_\-=]*$/.test(data) || data.length > Math.ceil(limit * 4 / 3) + 4) throw new ToolError('LIMIT');
  const bytes = Buffer.from(data, 'base64url'); if (bytes.length > limit) throw new ToolError('LIMIT'); return bytes;
}
export function attachments(accountId: string, message: GmailMessage): AttachmentMetadata[] {
  return parts(message).filter(p => Boolean(p.filename) || Boolean(p.body?.attachmentId)).map(p => ({
    accountId, messageId: message.id, threadId: message.threadId, partId: p.partId ?? '', filename: (p.filename || 'attachment').replace(/[\r\n\0]/g, '_').slice(0, 255),
    mimeType: p.mimeType && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(p.mimeType) ? p.mimeType : 'application/octet-stream', size: p.body?.size ?? 0, ...(p.body?.attachmentId ? { attachmentId: p.body.attachmentId } : {})
  }));
}
export async function messageView(accountId: string, message: GmailMessage) {
  if (!gmailId.safeParse(message.id).success || !gmailId.safeParse(message.threadId).success) throw new ToolError('UPSTREAM');
  const h = messageHeaders(message); const all = parts(message);
  const textPart = all.find(p => p.mimeType === 'text/plain' && !p.filename) ?? all.find(p => p.mimeType === 'text/html' && !p.filename);
  let text = '';
  if (textPart?.body?.data) {
    const buffer = decodeData(textPart.body.data, 1024 * 1024);
    const parsed = await simpleParser(Buffer.concat([Buffer.from(`Content-Type: ${textPart.mimeType === 'text/html' ? 'text/html' : 'text/plain'}; charset=utf-8\r\n\r\n`), buffer]), { skipImageLinks: true, skipTextToHtml: true });
    text = parsed.text ?? '';
  }
  return { accountId, messageId: message.id, threadId: message.threadId, from: h.get('from')?.slice(0, 1000), to: h.get('to')?.slice(0, 1000), cc: h.get('cc')?.slice(0, 1000), bcc: h.get('bcc')?.slice(0, 1000), subject: h.get('subject')?.slice(0, 500), date: h.get('date')?.slice(0, 100),
    labels: message.labelIds ?? [], snippet: message.snippet?.slice(0, 300), text: text.slice(0, 6000), textTruncated: text.length > 6000,
    attachments: attachments(accountId, message), externalData: true };
}
export interface OutgoingMail { from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; inReplyTo?: string; references?: string; threadId?: string }
export interface AttachmentBytes { filename: string; contentType: string; content: Buffer }
export async function parsedAddressHeaders(message: GmailMessage): Promise<{ from: string[]; to: string[]; cc: string[]; replyTo: string[] }> {
  const h = messageHeaders(message);
  const lines = ['from', 'to', 'cc', 'reply-to'].map(name => `${name}: ${(h.get(name) ?? '').replace(/[\r\n]/g, ' ')}`).join('\r\n');
  const parsed = await simpleParser(`${lines}\r\n\r\n`, { skipImageLinks: true, skipTextToHtml: true });
  const extract = (values: typeof parsed.from): string[] => (values?.value ?? []).map(v => v.address ?? '').filter(Boolean).map(v => emailSchema.parse(v));
  return { from: extract(parsed.from), to: extract(Array.isArray(parsed.to) ? parsed.to[0] : parsed.to), cc: extract(Array.isArray(parsed.cc) ? parsed.cc[0] : parsed.cc), replyTo: extract(parsed.replyTo) };
}
export async function compileMail(mail: OutgoingMail, files: AttachmentBytes[]): Promise<string> {
  const raw = await new MailComposer({ from: mail.from, to: mail.to, cc: mail.cc, bcc: mail.bcc, subject: mail.subject, text: mail.body,
    inReplyTo: mail.inReplyTo, references: mail.references, messageId: `<${randomUUID()}@jarvis.invalid>`,
    attachments: files.map(file => ({ filename: file.filename, contentType: file.contentType, content: file.content })),
    disableFileAccess: true, disableUrlAccess: true }).compile().build();
  // Gmail needs the Bcc header to deliver to Bcc recipients (no SMTP envelope).
  // MailComposer defaults to stripping it; restore it from validated addresses.
  const withBcc = mail.bcc.length ? Buffer.concat([Buffer.from(`Bcc: ${mail.bcc.join(', ')}\r\n`), raw]) : raw;
  if (withBcc.length > 12 * 1024 * 1024) throw new ToolError('LIMIT');
  return withBcc.toString('base64url');
}
export function mailDigest(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }
