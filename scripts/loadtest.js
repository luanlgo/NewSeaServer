#!/usr/bin/env node
// scripts/loadtest.js — Sobe N clientes falsos contra o servidor e mede o que
// dói: tráfego por jogador, tamanho do `state` e latência de ida e volta.
//
// Existe porque não dá para otimizar no escuro. Rode ANTES e DEPOIS de cada
// mudança e compare os números — especialmente `state médio` e o p99 do RTT.
//
// Uso:
//   node scripts/loadtest.js                          # 200 bots em localhost
//   node scripts/loadtest.js --bots 50                # menos bots
//   node scripts/loadtest.js --url ws://1.2.3.4:3001  # contra o servidor real
//   node scripts/loadtest.js --bots 200 --secs 60 --json antes.json
//
// Flags:
//   --url    ws://localhost:3001   servidor alvo
//   --bots   200                   quantidade de conexões
//   --secs   45                    duração da medição (fora o aquecimento)
//   --ramp   10                    segundos para subir todos os bots
//   --prefix lt_                   prefixo do nome das contas criadas
//   --json   <arquivo>             grava o resumo para comparar depois
//   --quiet                        só o resumo final
//
// AS CONTAS SÃO REAIS: o bot usa o mesmo register/login do jogo, então elas
// ficam no banco. Todas nascem com o mesmo prefixo justamente para dar para
// limpar depois:  DELETE FROM players WHERE name LIKE 'lt\_%';
'use strict';

const WebSocket = require('ws');
const fs   = require('fs');
const path = require('path');

// ── Argumentos ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const has = name => argv.includes('--' + name);

const URL      = arg('url', 'ws://localhost:3001');
const N_BOTS   = parseInt(arg('bots', '200'), 10);
const SECS     = parseInt(arg('secs', '45'), 10);
const RAMP_S   = parseInt(arg('ramp', '10'), 10);
const PREFIX   = arg('prefix', 'lt_');
const JSON_OUT = arg('json', '');
const QUIET    = has('quiet');

// Tokens de dispositivo: o servidor vincula um por conta no 1º login (TOFU) e
// depois exige o mesmo. Sem persistir, a 2ª rodada seria recusada em bloco.
const TOKEN_FILE = path.join(__dirname, '..', '.loadtest-tokens.json');
let tokens = {};
try { tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { /* 1ª rodada */ }

const PASSWORD = 'loadtest123';
const rnd = (a, b) => Math.random() * (b - a) + a;

// ── Métricas ──────────────────────────────────────────────────────────────────

const M = {
  connected: 0, loggedIn: 0, failed: 0, closed: 0,
  bytes: 0, msgs: 0,
  stateMsgs: 0, stateBytes: 0,
  rtts: [],
  errors: new Map(),
  // Contadores do último segundo, para o relatório ao vivo
  windowBytes: 0, windowMsgs: 0,
};
let measuring = false; // só conta depois que todos entraram

const noteError = e => M.errors.set(e, (M.errors.get(e) || 0) + 1);

// ── Bot ───────────────────────────────────────────────────────────────────────

class Bot {
  constructor(i) {
    this.name   = PREFIX + String(i).padStart(4, '0');
    this.secret = tokens[this.name] || require('crypto').randomBytes(32).toString('hex');
    this.ws     = null;
    this.alive  = false;
    this.tried  = new Set(); // 'login' / 'register' — evita ping-pong entre os dois
    // Estado do passeio aleatório
    this.dir    = { w: false, a: false, s: false, d: false };
    this.nextTurn = 0;
    this.pingAt = 0;
  }

  start() {
    const ws = new WebSocket(URL, { perMessageDeflate: false });
    this.ws = ws;

    ws.on('open', () => {
      M.connected++;
      // Token salvo = a conta já foi criada numa rodada anterior, então vai
      // direto de login. Sem token, cria primeiro.
      //
      // A decisão sai do arquivo de tokens, e não da resposta do servidor, de
      // propósito: as mensagens de erro são texto em português ("Conta não
      // encontrada...") e casar por texto quebra no dia em que alguém reescrever
      // a frase. Os dois sentidos ainda têm fallback abaixo, para o caso do
      // arquivo de tokens estar dessincronizado do banco.
      if (tokens[this.name]) this.doLogin(); else this.doRegister();
    });

    ws.on('message', (data) => {
      M.msgs++;
      M.bytes += data.length;
      if (measuring) { M.windowMsgs++; M.windowBytes += data.length; }

      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      switch (msg.type) {
        case 'state':
          M.stateMsgs++;
          M.stateBytes += data.length;
          break;

        case 'pong':
          if (this.pingAt) { M.rtts.push(Date.now() - this.pingAt); this.pingAt = 0; }
          break;

        // Login falhou (conta não existe, ou o servidor mudou de ideia sobre o
        // formato do erro): tenta criar. `tried` impede ping-pong infinito.
        case 'login_error':
        case 'auth_error':
          if (!this.tried.has('register')) { this.doRegister(); }
          else noteError('auth: ' + (msg.message || msg.reason || '?'));
          break;

        // Criar falhou — o caso normal é o nome já existir (arquivo de tokens
        // apagado, banco intacto). Cai para o login.
        case 'register_error':
          if (!this.tried.has('login')) { this.doLogin(); }
          else noteError('register: ' + (msg.message || '?'));
          break;

        case 'init':
          if (!this.alive) {
            this.alive = true;
            M.loggedIn++;
            tokens[this.name] = this.secret;
          }
          break;
      }
    });

    ws.on('error', (err) => { M.failed++; noteError('ws: ' + err.message); });
    ws.on('close', () => { M.closed++; this.alive = false; });
  }

  doLogin() {
    this.tried.add('login');
    this.send({ type: 'login', name: this.name, password: PASSWORD, secret: this.secret });
  }

  doRegister() {
    this.tried.add('register');
    this.send({
      type: 'register', name: this.name,
      email: `${this.name}@loadtest.local`,
      password: PASSWORD, gender: 'M', secret: this.secret,
    });
  }

  send(o) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  /** Passeio aleatório a 10 Hz — a mesma cadência de input do cliente real. */
  tick(now) {
    if (!this.alive) return;
    if (now >= this.nextTurn) {
      // Troca de rumo a cada 1-4 s. Sempre com alguma tecla apertada: barco
      // parado não exercita o broadcast (é justamente o caso barato).
      this.nextTurn = now + rnd(1000, 4000);
      this.dir = {
        w: Math.random() < 0.5, s: false,
        a: Math.random() < 0.3, d: Math.random() < 0.3,
      };
      if (!this.dir.w && !this.dir.a && !this.dir.d) this.dir.w = true;
      this.send({ type: 'input', ...this.dir });
    } else {
      this.send({ type: 'input', ...this.dir });
    }
  }

  ping(now) {
    if (!this.alive || this.pingAt) return;
    this.pingAt = now;
    this.send({ type: 'ping' });
  }

  stop() { try { this.ws && this.ws.close(); } catch { /* já fechado */ } }
}

// ── Estatística ───────────────────────────────────────────────────────────────

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const kb = b => (b / 1024).toFixed(1) + ' KB';

// ── Execução ──────────────────────────────────────────────────────────────────

/**
 * Abre UMA conexão antes de subir a frota. Sem isto, servidor fora do ar vira
 * 200 ECONNREFUSED, 45 s de espera e um relatório de zeros — que foi
 * exatamente o que aconteceu na primeira rodada.
 */
function preflight() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`sem resposta de ${URL} em 5 s`));
    }, 5000);
    ws.on('open',  () => { clearTimeout(timer); ws.close(); resolve(); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  console.log(`\n⚓ Load test — ${N_BOTS} bots → ${URL}`);
  console.log(`   rampa ${RAMP_S}s, medição ${SECS}s\n`);

  try {
    await preflight();
  } catch (err) {
    const dica = /ECONNREFUSED/.test(err.message)
      ? `\n   O servidor não está no ar em ${URL}.\n   Suba com:  node server.js     (ou npm run server)\n`
      : `\n   ${err.message}\n`;
    console.error(`\n❌ Não consegui abrir nem uma conexão.${dica}`);
    process.exit(1);
  }
  console.log(`   servidor respondeu — subindo ${N_BOTS} bots\n`);

  const bots = Array.from({ length: N_BOTS }, (_, i) => new Bot(i + 1));

  // Sobe em rampa: 200 handshakes + 200 logins (com scrypt no servidor!) de uma
  // vez só medem a fila de conexão, não o jogo em regime.
  const gap = (RAMP_S * 1000) / N_BOTS;
  for (let i = 0; i < N_BOTS; i++) {
    bots[i].start();
    await new Promise(r => setTimeout(r, gap));
  }

  // Aquecimento: espera todo mundo entrar (ou desiste em 20 s)
  const warmEnd = Date.now() + 20000;
  while (Date.now() < warmEnd && M.loggedIn < N_BOTS) {
    await new Promise(r => setTimeout(r, 250));
  }

  // Sem ninguém no jogo não há o que medir — melhor falar agora do que devolver
  // um relatório de zeros depois de SECS segundos.
  const nowOnline = bots.filter(b => b.alive).length;
  if (nowOnline === 0) {
    console.error(`\n❌ Nenhum bot entrou no jogo (${M.connected} conectaram, ${M.closed} caíram).`);
    if (M.errors.size) {
      console.error('   Erros:');
      for (const [e, n] of M.errors) console.error(`     ${n}x  ${e}`);
    } else {
      console.error('   Sem erro reportado — o servidor aceitou a conexão mas nunca mandou `init`.');
    }
    process.exit(1);
  }
  console.log(`   ${nowOnline}/${N_BOTS} bots no jogo. Medindo...\n`);

  // Zera o que veio da fase de login para medir só o regime permanente
  M.bytes = 0; M.msgs = 0; M.stateMsgs = 0; M.stateBytes = 0; M.rtts.length = 0;
  measuring = true;

  const inputTimer = setInterval(() => {
    const now = Date.now();
    for (const b of bots) b.tick(now);
  }, 100);

  const pingTimer = setInterval(() => {
    const now = Date.now();
    // Um punhado de bots por segundo — pingar todos poluiria a medição.
    for (let i = 0; i < Math.min(10, bots.length); i++) {
      bots[Math.floor(Math.random() * bots.length)].ping(now);
    }
  }, 1000);

  const t0 = Date.now();
  const liveTimer = setInterval(() => {
    if (QUIET) return;
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `   [${el}s] online ${bots.filter(b => b.alive).length}  ` +
      `rede ${(M.windowBytes / 1024).toFixed(0)} KB/s  ` +
      `msgs ${M.windowMsgs}/s  ` +
      `rtt p50 ${pct(M.rtts, 0.5)}ms p99 ${pct(M.rtts, 0.99)}ms`
    );
    M.windowBytes = 0; M.windowMsgs = 0;
  }, 1000);

  await new Promise(r => setTimeout(r, SECS * 1000));

  clearInterval(inputTimer); clearInterval(pingTimer); clearInterval(liveTimer);
  const elapsed = (Date.now() - t0) / 1000;

  // Conta os sockets que continuam de pé. `loggedIn - closed` dava número
  // negativo quando a conexão caía antes do login.
  const online = bots.filter(b => b.alive).length;
  const summary = {
    url: URL,
    bots: N_BOTS,
    online,
    // Vai no JSON de propósito: sem isto, uma rodada que falha inteira produz
    // um relatório de zeros sem nenhuma pista do motivo.
    erros: Object.fromEntries(M.errors),
    segundos: Math.round(elapsed),
    rede_total_KBs:      +(M.bytes / 1024 / elapsed).toFixed(1),
    rede_por_bot_KBs:    +(M.bytes / 1024 / elapsed / Math.max(1, online)).toFixed(2),
    msgs_por_s:          Math.round(M.msgs / elapsed),
    state_por_s:         Math.round(M.stateMsgs / elapsed),
    state_medio_bytes:   M.stateMsgs ? Math.round(M.stateBytes / M.stateMsgs) : 0,
    state_por_bot_por_s: +(M.stateMsgs / elapsed / Math.max(1, online)).toFixed(1),
    rtt_p50: pct(M.rtts, 0.5),
    rtt_p95: pct(M.rtts, 0.95),
    rtt_p99: pct(M.rtts, 0.99),
    falhas: M.failed,
    quedas: M.closed,
  };

  console.log('\n─────────────────────────────────────────────');
  console.log(`  bots online         : ${summary.online}/${N_BOTS}`);
  console.log(`  rede (servidor→bots): ${summary.rede_total_KBs} KB/s   (${summary.rede_por_bot_KBs} KB/s por bot)`);
  console.log(`  mensagens           : ${summary.msgs_por_s}/s`);
  console.log(`  state               : ${summary.state_por_s}/s, média ${kb(summary.state_medio_bytes)}`);
  console.log(`                        ${summary.state_por_bot_por_s}/s por bot  (10/s = sem economia de idle)`);
  console.log(`  RTT                 : p50 ${summary.rtt_p50}ms  p95 ${summary.rtt_p95}ms  p99 ${summary.rtt_p99}ms`);
  console.log(`  falhas / quedas     : ${summary.falhas} / ${summary.quedas}`);
  if (M.errors.size) {
    console.log('  erros:');
    for (const [e, n] of M.errors) console.log(`    ${n}x  ${e}`);
  }
  console.log('─────────────────────────────────────────────\n');

  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 0)); } catch { /* não é fatal */ }
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
    console.log(`  resumo salvo em ${JSON_OUT}\n`);
  }

  for (const b of bots) b.stop();
  setTimeout(() => process.exit(0), 500);
}

main().catch(e => { console.error(e); process.exit(1); });
