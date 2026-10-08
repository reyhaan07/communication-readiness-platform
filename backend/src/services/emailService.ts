import * as nodemailer from 'nodemailer';
import { env } from '../config/env';

let _transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

/** True when an SMTP account is configured, i.e. the platform can send email. */
export function emailConfigured(): boolean {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

/** Sends a "Forgot password" code. Throws when the mail server rejects the message. */
export async function sendPasswordResetCode(opts: { to: string; name: string; code: string; minutes: number }): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; margin: 0; padding: 32px 16px;">
  <div style="max-width: 520px; margin: 0 auto; background: white; border-radius: 12px; border: 1px solid #e5e7eb; padding: 40px;">
    <h1 style="font-size: 22px; font-weight: 700; color: #111827; margin: 0 0 6px">${env.APP_NAME}</h1>
    <p style="color: #6b7280; margin: 0 0 28px; font-size: 14px;">Password reset</p>
    <p style="color: #374151; font-size: 15px; line-height: 1.6;">Hi <strong>${escapeHtml(opts.name)}</strong>,</p>
    <p style="color: #374151; font-size: 15px; line-height: 1.6;">Use this code to reset your password:</p>
    <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <span style="font-family: monospace; font-size: 30px; font-weight: 700; letter-spacing: 8px; color: #111827;">${escapeHtml(opts.code)}</span>
    </div>
    <p style="color: #374151; font-size: 14px; line-height: 1.6;">The code expires in ${opts.minutes} minutes and works once.</p>
    <p style="color: #9ca3af; font-size: 12px; margin: 24px 0 0; border-top: 1px solid #f3f4f6; padding-top: 16px;">
      If you did not ask to reset your password, ignore this email; your password stays the same.
    </p>
  </div>
</body>
</html>`;
  const info = await getTransporter().sendMail({
    from: env.SMTP_FROM,
    to: opts.to,
    subject: `${opts.code} is your ${env.APP_NAME} password reset code`,
    text: `Your ${env.APP_NAME} password reset code is ${opts.code}. It expires in ${opts.minutes} minutes. If you did not ask for it, ignore this email.`,
    html,
  });
  console.log('[emailService] Password reset email sent messageId=', info.messageId);
}

export interface StaffWelcomeEmailOptions {
  to: string;
  name: string;
  role: string;
  password: string;
  createdBy: string;
}

// Names and emails come from admin input; never let them inject markup into the email.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendStaffWelcomeEmail(opts: StaffWelcomeEmailOptions): Promise<void> {
  if (!env.SMTP_USER) {
    console.warn('[emailService] SMTP_USER not set — skipping welcome email for', opts.to);
    return;
  }

  const roleName = opts.role
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; margin: 0; padding: 32px 16px;">
  <div style="max-width: 520px; margin: 0 auto; background: white; border-radius: 12px; border: 1px solid #e5e7eb; padding: 40px;">
    <div style="margin-bottom: 28px;">
      <h1 style="font-size: 22px; font-weight: 700; color: #111827; margin: 0 0 6px">${env.APP_NAME}</h1>
      <p style="color: #6b7280; margin: 0; font-size: 14px;">Your account has been created</p>
    </div>

    <p style="color: #374151; font-size: 15px; line-height: 1.6;">Hi <strong>${escapeHtml(opts.name)}</strong>,</p>
    <p style="color: #374151; font-size: 15px; line-height: 1.6;">
      <strong>${escapeHtml(opts.createdBy)}</strong> has created a <strong>${escapeHtml(roleName)}</strong> account for you on ${env.APP_NAME}.
      Use the credentials below to sign in.
    </p>

    <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; margin: 24px 0;">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr>
          <td style="color: #6b7280; padding: 4px 0; width: 90px;">Login URL</td>
          <td style="color: #111827; font-weight: 500;"><a href="${env.APP_URL}/login" style="color: #2563eb;">${env.APP_URL}/login</a></td>
        </tr>
        <tr>
          <td style="color: #6b7280; padding: 4px 0;">Email</td>
          <td style="color: #111827; font-weight: 500; font-family: monospace;">${escapeHtml(opts.to)}</td>
        </tr>
        <tr>
          <td style="color: #6b7280; padding: 4px 0;">Password</td>
          <td style="color: #111827; font-weight: 600; font-family: monospace; font-size: 16px; letter-spacing: 1px;">${escapeHtml(opts.password)}</td>
        </tr>
        <tr>
          <td style="color: #6b7280; padding: 4px 0;">Role</td>
          <td style="color: #111827; font-weight: 500;">${escapeHtml(roleName)}</td>
        </tr>
      </table>
    </div>

    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px;">
      <p style="margin: 0; font-size: 13px; color: #92400e;">
        <strong>Please change your password</strong> immediately after your first login via Account Settings.
      </p>
    </div>

    <p style="color: #9ca3af; font-size: 12px; margin: 24px 0 0; border-top: 1px solid #f3f4f6; padding-top: 16px;">
      This email was sent by ${env.APP_NAME}. If you did not expect this, please contact your administrator.
    </p>
  </div>
</body>
</html>`;

  const info = await getTransporter().sendMail({
    from: env.SMTP_FROM,
    to: opts.to,
    subject: `Your ${env.APP_NAME} account credentials`,
    html,
  });
  console.log('[emailService] Email sent OK messageId=', info.messageId, 'to=', opts.to);
}
