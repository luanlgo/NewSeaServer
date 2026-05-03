#!/usr/bin/env node
// scripts/publish.js — Prepara um novo build do jogo para distribuição.
//
// Uso:
//   node scripts/publish.js <versao> <pasta_do_build>
//
// Exemplo:
//   node scripts/publish.js 0.2.0 "C:\Work\NewSeaGodot\builds\windows"
//
// O script:
//   1. Calcula SHA-256 de SeaOfCode.exe e SeaOfCode.pck
//   2. Atualiza launcher-manifest.json com a nova versão + hashes
//   3. Instrui como subir os arquivos para o GitHub Releases
//
// Após rodar:
//   - Abra o launcher-manifest.json e adicione o changelog manualmente (ou passe --changelog)
//   - Suba os arquivos indicados para o GitHub Release da versão
//   - Reinicie o servidor (ou não — a rota /launcher/manifest usa delete require.cache)

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Argumentos ───────────────────────────────────────────────────────────────
const [,, version, buildDir] = process.argv;

if (!version || !buildDir) {
  console.error('Uso: node scripts/publish.js <versao> <pasta_do_build>');
  console.error('Ex:  node scripts/publish.js 0.2.0 "C:\\Work\\NewSeaGodot\\builds\\windows"');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Versão deve estar no formato x.y.z (ex: 0.2.0)');
  process.exit(1);
}

if (!fs.existsSync(buildDir)) {
  console.error('Pasta não encontrada:', buildDir);
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────────────────────────
// Altere para o seu repositório GitHub
const GITHUB_REPO  = 'luanlgo/NewSea';
const FILES_TO_PACK = ['SeaOfCode.exe', 'SeaOfCode.pck'];

const manifestPath = path.join(__dirname, '..', 'launcher-manifest.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function formatBytes(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

// ── Processar arquivos ────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════╗');
console.log('║  Sea of Code — Publish Script                ║');
console.log('╚══════════════════════════════════════════════╝\n');
console.log(`Versão : ${version}`);
console.log(`Build  : ${buildDir}\n`);

const files = [];

for (const name of FILES_TO_PACK) {
  const filePath = path.join(buildDir, name);
  if (!fs.existsSync(filePath)) {
    console.warn(`  [SKIP] ${name} — arquivo não encontrado`);
    continue;
  }
  const stat = fs.statSync(filePath);
  process.stdout.write(`  [..] ${name} — calculando hash...`);
  const hash = sha256File(filePath);
  console.log(`\r  [OK] ${name} — ${formatBytes(stat.size)} — ${hash.slice(0, 12)}...`);

  files.push({
    name,
    url:    `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${name}`,
    sha256: hash,
    size:   stat.size,
  });
}

if (files.length === 0) {
  console.error('\nNenhum arquivo encontrado. Verifique a pasta de build.');
  process.exit(1);
}

// ── Atualizar manifest ────────────────────────────────────────────────────────
let manifest = {};
if (fs.existsSync(manifestPath)) {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

const prevVersion = manifest.version || '0.0.0';
manifest.version  = version;
manifest.date     = new Date().toISOString().slice(0, 10);
manifest.files    = files;

// Preserva changelog se a versão for a mesma, senão adiciona placeholder
if (version !== prevVersion) {
  if (!Array.isArray(manifest.changelog)) manifest.changelog = [];
  manifest.changelog.unshift(`[v${version}] — descreva as mudanças aqui`);
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// ── Instruções finais ─────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────');
console.log(`Manifest atualizado → launcher-manifest.json`);
console.log('────────────────────────────────────────────────');
console.log('\nPróximos passos:\n');
console.log(`  1. Edite o campo "changelog" no launcher-manifest.json`);
console.log(`     para descrever as novidades da versão ${version}\n`);
console.log(`  2. Crie um GitHub Release com a tag v${version}:`);
console.log(`     https://github.com/${GITHUB_REPO}/releases/new\n`);
console.log(`  3. Faça upload dos arquivos abaixo no release:`);
for (const f of files) {
  console.log(`     • ${path.join(buildDir, f.name)}`);
}
console.log(`\n  4. Publique o release e o launcher já vai pegar automaticamente.`);
console.log(`     (O servidor relê o manifest.json sem precisar reiniciar)\n`);
