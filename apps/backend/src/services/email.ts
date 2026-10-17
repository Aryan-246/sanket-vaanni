/**
 * Reusable Nodemailer Email Service for Sanket Vaanni Backend.
 *
 * Dedicated strictly to application transactional, security, and export emails.
 *
 * IMPORTANT ARCHITECTURAL BOUNDARY:
 * Supabase Auth remains exclusively responsible for user authentication emails
 * (email confirmation, password recovery, magic links). This service does NOT
 * replace or duplicate those Supabase Auth workflows.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { SmtpConfig } from '../config.js';

let transporterInstance: Transporter | null = null;
let currentConfig: SmtpConfig | null = null;

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

/**
 * Initializes or updates the Nodemailer transporter.
 */
export function initEmailService(smtpConfig: SmtpConfig): Transporter | null {
  currentConfig = smtpConfig;

  if (!smtpConfig.pass || smtpConfig.pass.trim().length === 0) {
    transporterInstance = null;
    return null;
  }

  transporterInstance = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure, // true for 465, false for 587
    auth: {
      // Must match `smtp.user` in config.ts. The one-n spelling that used to be
      // here named a mailbox that does not receive this project's mail.
      user: smtpConfig.user ?? 'sanketvaanni.auth@gmail.com',
      pass: smtpConfig.pass.trim(),
    },
  });

  return transporterInstance;
}

/**
 * Checks whether SMTP credentials (specifically the App Password) are configured.
 */
export function isEmailConfigured(): boolean {
  return transporterInstance !== null && Boolean(currentConfig?.pass);
}

/**
 * Verifies SMTP transport connectivity against the mail server.
 */
export async function verifySmtpConnection(): Promise<{ connected: boolean; error?: string }> {
  if (!transporterInstance) {
    return {
      connected: false,
      error: 'SMTP is not configured. Provide SMTP_PASS in backend environment.',
    };
  }

  try {
    await transporterInstance.verify();
    return { connected: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { connected: false, error: errorMsg };
  }
}

/**
 * Sends a generic transactional email.
 * Never logs the password or credentials.
 */
export async function sendTransactionalEmail(
  options: SendEmailOptions,
): Promise<EmailDeliveryResult> {
  if (!transporterInstance || !currentConfig) {
    return {
      accepted: false,
      error: 'SMTP service is unconfigured. Set SMTP_PASS in backend .env to enable email delivery.',
    };
  }

  try {
    const info = await transporterInstance.sendMail({
      from: currentConfig.from,
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
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      accepted: false,
      error: errorMsg,
    };
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
