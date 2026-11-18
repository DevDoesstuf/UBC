/*
 * Huddle QuickNode Streams filter (Solana devnet, dataset "Block"; the "Programs + Logs" shape works too).
 *
 * Paste this whole file into the Stream's filter editor ("Customize your payload"). Set the two values below first
 * (`node scripts/solana-go-live.mjs` prints them filled in):
 *   HUDDLE_PROGRAM_ID  the huddle_vault program
 *   WATCH_ACCOUNTS     the treasury's USDC token account (where Solana Pay deposits land)
 *
 * QuickNode calls main(stream) once per batch: stream.data is an array of blocks shaped like `getBlock`
 * (transactions[].transaction + transactions[].meta), stream.metadata has the network and batch range. The filter
 * keeps only SUCCESSFUL transactions that touch the vault program or a watched account, and returns one small
 * record per transaction:
 *
 *   { signature, slot, blockTime, accounts: [every account key], watched: [matched watched keys],
 *     huddle: [{ instruction, party, member, amount? }] }
 *
 * `accounts` lets Huddle find the Solana Pay reference key (a read-only account of the transfer) and credit the
 * deposit at once; `huddle` names the vault steps (deposit, request_close, submit_state, finalize, withdraw...) for
 * the TV. Huddle never trusts these records for money: it re-reads every credited transaction from its own RPC.
 * A batch with nothing of ours returns null, so QuickNode delivers nothing.
 *
 * Filters run in a sandbox without require/import/Buffer, so everything is plain ES5 below.
 */

var HUDDLE_PROGRAM_ID = 'GRpABdrQhDya9n2zuf19w2idbL3CRSqmWYTJs52taRHu';
var WATCH_ACCOUNTS = [
  // the treasury's USDC associated token account, e.g. 'Ab3...'
];

// Anchor instruction discriminators, sha256("global:<name>")[0..8].
var HUDDLE_IX = {
  create_party: [251, 84, 246, 151, 106, 204, 201, 22],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  request_close: [82, 168, 167, 86, 14, 15, 199, 180],
  submit_state: [172, 31, 42, 160, 233, 237, 4, 251],
  finalize: [171, 61, 218, 56, 127, 115, 12, 217],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  withdraw_host: [103, 247, 115, 166, 187, 165, 7, 18],
};
// Account positions of the party PDA and the member; byte offsets of amounts / member keys in the data.
var HUDDLE_LAYOUT = {
  create_party: { party: 2, member: 1, amountAt: 76 },
  deposit: { party: 2, member: 1, amountAt: 8 },
  request_close: { party: 1, member: 0 },
  submit_state: { party: 0, member: -1, memberAt: 8, amountAt: 48 },
  finalize: { party: 0, member: -1 },
  withdraw: { party: 1, member: 3 },
  withdraw_host: { party: 1, member: 2 },
};

var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b58decode(s) {
  var zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  var bytes = [];
  for (var i = zeros; i < s.length; i++) {
    var carry = B58.indexOf(s[i]);
    if (carry < 0) return null;
    for (var j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  var out = [];
  for (var z = 0; z < zeros; z++) out.push(0);
  for (var k = bytes.length - 1; k >= 0; k--) out.push(bytes[k]);
  return out;
}

function b58encode(bytes) {
  var zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  var digits = [];
  for (var i = zeros; i < bytes.length; i++) {
    var carry = bytes[i];
    for (var j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  var out = '';
  for (var z = 0; z < zeros; z++) out += '1';
  for (var k = digits.length - 1; k >= 0; k--) out += B58[digits[k]];
  return out;
}

function b64decode(s) {
  var clean = String(s).replace(/=+$/, '');
  var out = [];
  var buf = 0;
  var bits = 0;
  for (var i = 0; i < clean.length; i++) {
    var v = B64.indexOf(clean[i]);
    if (v < 0) return null;
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

function readU64(b, at) {
  var v = 0;
  for (var i = 7; i >= 0; i--) v = v * 256 + b[at + i];
  return v;
}

function hasPrefix(b, p) {
  if (!b || b.length < p.length) return false;
  for (var i = 0; i < p.length; i++) if (b[i] !== p[i]) return false;
  return true;
}

/** Instruction data: base58 in the `json` encoding; base64 ([data, "base64"]) and byte arrays also accepted. */
function ixBytes(data) {
  if (Array.isArray(data)) {
    if (data.length === 2 && typeof data[0] === 'string' && data[1] === 'base64') return b64decode(data[0]);
    return data;
  }
  if (typeof data === 'string') return b58decode(data);
  return null;
}

function keyOf(k) {
  return typeof k === 'string' ? k : k && typeof k.pubkey === 'string' ? k.pubkey : null;
}

function decodeHuddleIx(data, accounts) {
  var b = ixBytes(data);
  if (!b) return null;
  for (var name in HUDDLE_IX) {
    if (!hasPrefix(b, HUDDLE_IX[name])) continue;
    var lay = HUDDLE_LAYOUT[name];
    var out = { instruction: name, party: accounts[lay.party] || null, member: null };
    if (lay.member >= 0 && accounts[lay.member]) out.member = accounts[lay.member];
    if (lay.memberAt !== undefined && b.length >= lay.memberAt + 32) out.member = b58encode(b.slice(lay.memberAt, lay.memberAt + 32));
    if (lay.amountAt !== undefined && b.length >= lay.amountAt + 8) out.amount = readU64(b, lay.amountAt);
    return out;
  }
  return null;
}

function succeeded(meta) {
  if (!meta) return true;
  if (meta.err !== undefined && meta.err !== null) return false;
  if (meta.status && meta.status.Err !== undefined) return false;
  return true;
}

function watchedIn(keys) {
  var hit = [];
  for (var i = 0; i < WATCH_ACCOUNTS.length; i++) if (keys.indexOf(WATCH_ACCOUNTS[i]) >= 0) hit.push(WATCH_ACCOUNTS[i]);
  return hit;
}

/** One getBlock-shaped transaction -> a record, or null. */
function fromBlockTx(tx, slot, blockTime) {
  if (!tx || !tx.transaction || !succeeded(tx.meta)) return null;
  var msg = tx.transaction.message || {};
  var keys = (msg.accountKeys || []).map(keyOf);
  var loaded = tx.meta && tx.meta.loadedAddresses;
  if (loaded) keys = keys.concat(loaded.writable || [], loaded.readonly || []);
  var watched = watchedIn(keys);
  var touchesProgram = keys.indexOf(HUDDLE_PROGRAM_ID) >= 0;
  if (!touchesProgram && !watched.length) return null;
  var huddle = [];
  var ixs = msg.instructions || [];
  for (var i = 0; i < ixs.length; i++) {
    var ix = ixs[i];
    var programId = ix.programId || (typeof ix.programIdIndex === 'number' ? keys[ix.programIdIndex] : null);
    if (programId !== HUDDLE_PROGRAM_ID) continue;
    var accounts = (ix.accounts || []).map(function (a) {
      return typeof a === 'number' ? keys[a] : keyOf(a);
    });
    var dec = decodeHuddleIx(ix.data, accounts);
    if (dec) huddle.push(dec);
  }
  return { signature: (tx.transaction.signatures || [])[0], slot: slot, blockTime: blockTime, accounts: keys, watched: watched, huddle: huddle };
}

/** One "Programs + Logs" entry -> a record, or null (it only lists program invocations, so watched accounts come from them). */
function fromProgramsEntry(e) {
  if (!e || e.success === false || !succeeded(e.meta)) return null;
  var keys = [];
  var huddle = [];
  var inv = e.programInvocations || [];
  for (var i = 0; i < inv.length; i++) {
    var accounts = ((inv[i].instruction && inv[i].instruction.accounts) || []).map(keyOf);
    for (var a = 0; a < accounts.length; a++) if (keys.indexOf(accounts[a]) < 0) keys.push(accounts[a]);
    if (inv[i].programId === HUDDLE_PROGRAM_ID && inv[i].instruction) {
      if (keys.indexOf(HUDDLE_PROGRAM_ID) < 0) keys.push(HUDDLE_PROGRAM_ID);
      var dec = decodeHuddleIx(inv[i].instruction.data, accounts);
      if (dec) huddle.push(dec);
    }
  }
  var watched = watchedIn(keys);
  if (!huddle.length && !watched.length) return null;
  return { signature: e.signature, slot: e.slot, blockTime: e.blockTime, accounts: keys, watched: watched, huddle: huddle };
}

function walk(item, slotHint, out, depth) {
  if (!item || depth > 4) return;
  if (Array.isArray(item)) {
    for (var i = 0; i < item.length; i++) walk(item[i], slotHint === null ? null : slotHint + i, out, depth + 1);
    return;
  }
  if (Array.isArray(item.transactions)) {
    var slot = typeof item.slot === 'number' ? item.slot : typeof item.parentSlot === 'number' ? item.parentSlot + 1 : slotHint;
    var blockTime = typeof item.blockTime === 'number' ? item.blockTime : null;
    for (var t = 0; t < item.transactions.length; t++) {
      var r = fromBlockTx(item.transactions[t], slot, blockTime);
      if (r) out.push(r);
    }
  } else if (item.programInvocations) {
    var p = fromProgramsEntry(item);
    if (p) out.push(p);
  }
}

// QuickNode calls main(); nothing in this file does.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function main(stream) {
  var data = stream && stream.data !== undefined ? stream.data : stream;
  var meta = (stream && stream.metadata) || {};
  var first = typeof meta.batch_start_range === 'number' ? meta.batch_start_range : null;
  var out = [];
  walk(data, first, out, 0);
  return out.length ? out : null;
}
