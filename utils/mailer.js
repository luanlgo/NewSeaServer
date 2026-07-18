// utils/mailer.js — Envio de e-mail (código de recuperação de senha).
// Usa nodemailer se instalado E se SMTP_HOST estiver configurado no .env:
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=465            (465 = TLS implícito; 587 = STARTTLS)
//   SMTP_USER=conta@gmail.com
//   SMTP_PASS=app-password   (Gmail: senha de app, não a senha da conta)
//   SMTP_FROM="Sea of Code <conta@gmail.com>"   (opcional; default = SMTP_USER)
//
// Sem SMTP configurado (dev local), o código é apenas logado no console do
// servidor — dá pra testar o fluxo inteiro sem mandar e-mail de verdade.

'use strict';

let _transport = null;
let _transportTried = false;

function _getTransport() {
  if (_transportTried) return _transport;
  _transportTried = true;
  if (!process.env.SMTP_HOST) return null;
  try {
    const nodemailer = require('nodemailer');
    const port = parseInt(process.env.SMTP_PORT) || 465;
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    console.log(`📧 Mailer pronto (${process.env.SMTP_HOST}:${port})`);
  } catch (err) {
    console.warn('📧 nodemailer não instalado — códigos de recuperação serão logados no console.');
    _transport = null;
  }
  return _transport;
}

// Envia o código de recuperação. Nunca lança — retorna true/false.
async function sendRecoveryCode(email, code) {
  const transport = _getTransport();
  if (!transport) {
    // Modo dev: sem SMTP, loga o código para teste manual.
    console.log(`📧 [DEV] Código de recuperação para ${email}: ${code}`);
    return true;
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Sea of Code — Recuperação de senha',
      text:
        `Seu código de recuperação de senha é: ${code}\n\n` +
        `Ele expira em 15 minutos. Se você não pediu a recuperação, ignore este e-mail.`,
      html:
        `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0d1522;color:#e8e0c8;border-radius:12px">` +
        `<h2 style="color:#d4af37;margin-top:0">⚓ Sea of Code</h2>` +
        `<p>Seu código de recuperação de senha é:</p>` +
        `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#d4af37;text-align:center">${code}</p>` +
        `<p style="color:#9aa3ab;font-size:13px">Ele expira em 15 minutos. Se você não pediu a recuperação, ignore este e-mail.</p>` +
        `</div>`,
    });
    return true;
  } catch (err) {
    console.error(`📧 Falha ao enviar e-mail para ${email}:`, err.message);
    return false;
  }
}

module.exports = { sendRecoveryCode };
