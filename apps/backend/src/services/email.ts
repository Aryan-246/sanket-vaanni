/**
 * Reusable email service for Sanket Vaanni Backend.
 *
 * Dedicated strictly to application transactional, security, and export emails.
 *
 * IMPORTANT ARCHITECTURAL BOUNDARY:
 * Supabase Auth remains exclusively responsible for user authentication emails
 * (email confirmation, password recovery, magic links). This service does NOT
 * replace or duplicate those Supabase Auth workflows.
 *
 * ## Two transports, one switch
 *
 * SMTP is the original path and remains the default. Some hosts refuse
 * outbound SMTP entirely — Render's free tier among them — and on those a
 * correct SMTP credential still times out. For that case `EMAIL_PROVIDER=brevo`
 * sends through Brevo's HTTPS API instead. The sender address is unchanged:
 * both paths send as whatever `SMTP_FROM` says.
 *
 * The provider is chosen explicitly. The service never silently falls back
 * from one transport to another: a silent fallback would make a delivery
 * failure look like a delivery success on the other path.
 */

import nodemailer, { type Transporter } from 'nodemailer';

import type { EmailProvider, SmtpConfig } from '../config.js';

export interface EmailDeliveryResult {
  accepted: boolean;
  messageId?: string;
  response?: string;
  error?: string;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

export interface EmailServiceConfig {
  readonly smtp: SmtpConfig;
  readonly provider: EmailProvider;
  readonly brevoApiKey?: string;
  readonly brevoEndpoint: string;
}

type TransportState =
  | { readonly provider: 'smtp'; readonly transporter: Transporter }
  | { readonly provider: 'brevo'; readonly apiKey: string; readonly endpoint: string };

let transport: TransportState | null = null;
let currentConfig: EmailServiceConfig | null = null;

/**
 * Initializes or replaces the delivery transport.
 *
 * Returns the Nodemailer transport when SMTP is in use (the historical return
 * value), and `null` for the HTTP provider, which has no transporter object.
 */
export function initEmailService(config: EmailServiceConfig): Transporter | null {
  currentConfig = config;

  if (config.provider === 'brevo') {
    const apiKey = config.brevoApiKey?.trim();
    if (!apiKey) {
      // Configured for Brevo but with no key: report unavailable rather than
      // pretending the SMTP credentials in the same environment are in use.
      transport = null;
      return null;
    }
    transport = { provider: 'brevo', apiKey, endpoint: config.brevoEndpoint.replace(/\/+$/, '') };
    return null;
  }

  const smtp = config.smtp;
  if (!smtp.pass || smtp.pass.trim().length === 0) {
    transport = null;
    return null;
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure, // true for 465, false for 587
    auth: {
      // Must match `smtp.user` in config.ts. The one-n spelling that used to be
      // here named a mailbox that does not receive this project's mail.
      user: smtp.user ?? 'sanketvaanni.auth@gmail.com',
      pass: smtp.pass.trim(),
    },
  });

  transport = { provider: 'smtp', transporter };
  return transporter;
}

/** The transport actually in use, for status reporting. */
export function emailProviderInUse(): EmailProvider | null {
  return transport?.provider ?? null;
}

/** Whether the configured transport has everything it needs to attempt a send. */
export function isEmailConfigured(): boolean {
  return transport !== null;
}

/**
 * Verifies the transport can reach its provider.
 *
 * For SMTP this is the historical `transporter.verify()`. For Brevo it is a
 * read-only account call: it proves the key is accepted without sending mail.
 */
export async function verifyEmailConnection(): Promise<{ connected: boolean; error?: string }> {
  if (!transport) {
    return {
      connected: false,
      error: currentConfig?.provider === 'brevo'
        ? 'Brevo is selected but BREVO_API_KEY is not set.'
        : 'SMTP is not configured. Provide SMTP_PASS in backend environment.',
    };
  }

  if (transport.provider === 'smtp') {
    try {
      await transport.transporter.verify();
      return { connected: true };
    } catch (err) {
      return { connected: false, error: errorMessage(err) };
    }
  }

  try {
    const response = await fetch(`${transport.endpoint}/account`, {
      method: 'GET',
      headers: { accept: 'application/json', 'api-key': transport.apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return {
        connected: false,
        error: `Brevo rejected the API key (HTTP ${response.status}).`,
      };
    }
    return { connected: true };
  } catch (err) {
    return { connected: false, error: errorMessage(err) };
  }
}

/**
 * Historical name for {@link verifyEmailConnection}.
 *
 * The admin health route and its tests inject this name. It now covers both
 * transports, so the name is kept as an alias rather than silently changing
 * the meaning of an exported symbol callers already depend on.
 */
export const verifySmtpConnection = verifyEmailConnection;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Splits `Name <a@b>` into the parts the Brevo API expects. */
export function parseSender(from: string): { email: string; name?: string } {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    const name = (match[1] ?? '').trim();
    const email = (match[2] ?? '').trim();
    if (email) return { email, ...(name ? { name } : {}) };
  }
  return { email: from.trim() };
}

/** Sends one message through the Brevo HTTPS API. */
async function sendViaBrevo(
  state: Extract<TransportState, { provider: 'brevo' }>,
  from: string,
  options: SendEmailOptions,
): Promise<EmailDeliveryResult> {
  try {
    const response = await fetch(`${state.endpoint}/smtp/email`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': state.apiKey,
      },
      body: JSON.stringify({
        sender: parseSender(from),
        to: [{ email: options.to }],
        subject: options.subject,
        htmlContent: options.html,
        textContent: options.text,
        ...(options.replyTo ? { replyTo: { email: options.replyTo } } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      // Brevo's body carries a human-readable reason (for example an
      // unverified sender). The API key is never part of that body.
      return {
        accepted: false,
        error: `Brevo refused the message (HTTP ${response.status}): ${bodyText.slice(0, 300)}`,
      };
    }

    let messageId: string | undefined;
    try {
      const parsed = JSON.parse(bodyText) as { messageId?: unknown };
      if (typeof parsed.messageId === 'string') messageId = parsed.messageId;
    } catch {
      // A 2xx with a non-JSON body is still an acceptance; keep the raw text.
    }

    // Brevo returns 201 Created with a message id. A 2xx without one is
    // reported as accepted but with the raw response, not invented metadata.
    return { accepted: true, messageId, response: bodyText.slice(0, 300) };
  } catch (err) {
    return { accepted: false, error: errorMessage(err) };
  }
}

/**
 * Sends a generic transactional email.
 * Never logs the password, API key or other credentials.
 */
export async function sendTransactionalEmail(
  options: SendEmailOptions,
): Promise<EmailDeliveryResult> {
  if (!transport || !currentConfig) {
    return {
      accepted: false,
      error: currentConfig?.provider === 'brevo'
        ? 'Email delivery is not configured. Set BREVO_API_KEY in the backend environment.'
        : 'SMTP service is unconfigured. Set SMTP_PASS in backend .env to enable email delivery.',
    };
  }

  const from = currentConfig.smtp.from;

  if (transport.provider === 'brevo') {
    return sendViaBrevo(transport, from, options);
  }

  try {
    const info = await transport.transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
      replyTo: options.replyTo,
    });

    const isAccepted = Array.isArray(info.accepted) && info.accepted.length > 0;

    return {
      accepted: isAccepted,
      messageId: info.messageId,
      response: typeof info.response === 'string' ? info.response : undefined,
    };
  } catch (err) {
    return { accepted: false, error: errorMessage(err) };
  }
}

/**
 * Security Alert Email Template.
 * Dispatched on sensitive account events (e.g. device link change, account deletion request, new login location).
 */
export async function sendSecurityAlertEmail(
  toEmail: string,
  details: {
    eventType: string;
    description: string;
    timestamp?: string;
    userAgentOrDevice?: string;
  },
): Promise<EmailDeliveryResult> {
  const timestamp = details.timestamp ?? new Date().toUTCString();
  const subject = `[Sanket Vaanni Security Alert] ${details.eventType}`;

  const text = `Sanket Vaanni Security Notice\n\n` +
    `Event: ${details.eventType}\n` +
    `Details: ${details.description}\n` +
    `Time: ${timestamp}\n` +
    (details.userAgentOrDevice ? `Device / Source: ${details.userAgentOrDevice}\n\n` : '\n') +
    `If you did not perform this action, please secure your account immediately or contact support at sanketvaanni@gmail.com.\n`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #ef4444; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #0f172a; margin: 0; font-size: 20px;">Sanket Vaanni Security Alert</h2>
      </div>
      <p style="color: #334155; font-size: 15px; line-height: 1.5;">A security-relevant event was detected on your Sanket Vaanni account:</p>
      <div style="background: #f8fafc; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
        <p style="margin: 4px 0; font-weight: 600; color: #0f172a;">${details.eventType}</p>
        <p style="margin: 4px 0; color: #475569; font-size: 14px;">${details.description}</p>
        <p style="margin: 4px 0; color: #64748b; font-size: 12px;"><strong>Timestamp:</strong> ${timestamp}</p>
        ${details.userAgentOrDevice ? `<p style="margin: 4px 0; color: #64748b; font-size: 12px;"><strong>Device:</strong> ${details.userAgentOrDevice}</p>` : ''}
      </div>
      <p style="color: #64748b; font-size: 13px; line-height: 1.4;">If you authorized this event, no further action is necessary. If you did not recognize this activity, please change your password in the mobile app immediately.</p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="color: #94a3b8; font-size: 11px; margin: 0;">Sanket Vaanni Project &bull; Real-time ISL Gesture Translation &bull; Offline-First</p>
    </div>
  `;

  return sendTransactionalEmail({
    to: toEmail,
    subject,
    text,
    html,
  });
}

/**
 * Onboarding / Welcome Notification Email Template.
 * Introduces users to smart glove pairing, flex sensor calibration, and 3D visualizer features.
 */
export async function sendWelcomeOnboardingEmail(
  toEmail: string,
  userName?: string,
): Promise<EmailDeliveryResult> {
  const greeting = userName ? `Welcome, ${userName}!` : 'Welcome to Sanket Vaanni!';
  const subject = 'Welcome to Sanket Vaanni — Smart Glove & Sign Translation Setup';

  const text = `${greeting}\n\n` +
    `Thank you for joining Sanket Vaanni.\n\n` +
    `Here is how to get started:\n` +
    `1. Launch the Sanket Vaanni mobile app.\n` +
    `2. Pair your sensory glove via Bluetooth Low Energy in Dashboard.\n` +
    `3. Perform flex sensor calibration in the 3D Hand Gesture Viewer.\n` +
    `4. Customize your OLED Studio dual-hand presets in More settings.\n\n` +
    `Support: sanketvaanni@gmail.com\n`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #3b82f6; padding-bottom: 12px; margin-bottom: 16px;">
        <h2 style="color: #0f172a; margin: 0; font-size: 20px;">${greeting}</h2>
      </div>
      <p style="color: #334155; font-size: 15px; line-height: 1.5;">Thank you for using Sanket Vaanni, an assistive Indian Sign Language (ISL) recognition and translation platform.</p>
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 14px 18px; margin: 16px 0; border-radius: 8px;">
        <h4 style="margin: 0 0 8px 0; color: #166534; font-size: 15px;">Quick Start Guide</h4>
        <ul style="margin: 0; padding-left: 20px; color: #15803d; font-size: 14px; line-height: 1.6;">
          <li><strong>Bluetooth Pairing:</strong> Connect your sensory glove from the mobile Dashboard.</li>
          <li><strong>3D Hand Visualizer:</strong> Inspect real-time 3D finger flex angles and pitch/roll.</li>
          <li><strong>Sensor Calibration:</strong> Calibrate min/max flex resistance in Settings for optimal gesture recognition.</li>
          <li><strong>OLED Studio:</strong> Customize on-glove presets and line layouts.</li>
        </ul>
      </div>
      <p style="color: #64748b; font-size: 13px;">All core gesture recognition operates 100% offline-first on your device.</p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="color: #94a3b8; font-size: 11px; margin: 0;">Sanket Vaanni &bull; sanketvaanni@gmail.com</p>
    </div>
  `;

  return sendTransactionalEmail({
    to: toEmail,
    subject,
    text,
    html,
  });
}
