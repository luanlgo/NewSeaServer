// utils/password.js — Hash e verificação de senha de conta.
// Usa scrypt do Node (sem dependência externa). Formato armazenado:
//   scrypt$<saltHex>$<hashHex>
// O verify é constant-time (timingSafeEqual) para evitar timing attacks.

'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const KEY_LEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(String(password), salt, KEY_LEN)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const check = (await scrypt(String(password), salt, KEY_LEN)).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { hashPassword, verifyPassword };
