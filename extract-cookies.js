/**
 * Extract ANA cookies from Chrome's cookie database.
 *
 * Chrome encrypts cookies with AES-256-GCM, using a key stored in Local State
 * that's itself encrypted with Windows DPAPI. This script decrypts them and
 * saves to data/cookies.json for the bot to use.
 *
 * Usage: node extract-cookies.js
 * (Chrome must be closed first)
 */
require('dotenv').config();
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join(
  process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'
);
const CHROME_PROFILE = process.env.CHROME_PROFILE || 'Default';
const COOKIE_OUTPUT = path.join(__dirname, 'data', 'cookies.json');

// Domains to extract cookies for
const DOMAINS = ['ana.co.jp', 'aswbe-i.ana.co.jp'];

function getEncryptionKey() {
  const localStatePath = path.join(CHROME_PROFILE_DIR, 'Local State');
  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encryptedKeyB64 = localState.os_crypt.encrypted_key;
  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');

  // Remove 'DPAPI' prefix (5 bytes)
  const keyWithoutPrefix = encryptedKey.slice(5);

  // Decrypt using Windows DPAPI via PowerShell (use temp files to avoid escaping issues)
  const tmpIn = path.join(__dirname, 'data', 'dpapi-in.tmp');
  const tmpOut = path.join(__dirname, 'data', 'dpapi-out.tmp');
  fs.writeFileSync(tmpIn, keyWithoutPrefix);

  const psScript = `
Add-Type -AssemblyName System.Security
$encrypted = [System.IO.File]::ReadAllBytes('${tmpIn.replace(/\\/g, '\\\\')}')
$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.IO.File]::WriteAllBytes('${tmpOut.replace(/\\/g, '\\\\')}', $decrypted)
`.trim();

  const tmpPs = path.join(__dirname, 'data', 'dpapi.ps1');
  fs.writeFileSync(tmpPs, psScript);
  execSync(`powershell -ExecutionPolicy Bypass -File "${tmpPs}"`, { windowsHide: true });

  const decryptedKey = fs.readFileSync(tmpOut);
  fs.unlinkSync(tmpIn);
  fs.unlinkSync(tmpOut);
  fs.unlinkSync(tmpPs);

  return decryptedKey;
}

function decryptCookieValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length === 0) return '';

  // Check for v10/v20 prefix (Chrome's AES-256-GCM encryption)
  const prefix = encryptedValue.slice(0, 3).toString('ascii');
  if (prefix === 'v10' || prefix === 'v20') {
    // v10: 3-byte prefix + 12-byte nonce + ciphertext + 16-byte tag
    // v20: 3-byte prefix + 12-byte nonce + ciphertext + 16-byte tag (same structure, different key derivation in some builds)
    const nonce = encryptedValue.slice(3, 3 + 12);
    const payload = encryptedValue.slice(3 + 12);
    const tag = payload.slice(payload.length - 16);
    const ciphertext = payload.slice(0, payload.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (e) {
      // v20 might use app-bound encryption on newer Chrome — try without the prefix
      return `[DECRYPT_FAILED:${e.message}]`;
    }
  }

  // Unencrypted (old Chrome) or DPAPI-encrypted
  return encryptedValue.toString('utf8');
}

function main() {
  console.log('=== Chrome Cookie Extractor ===\n');
  console.log(`Profile: ${CHROME_PROFILE_DIR}/${CHROME_PROFILE}`);

  // Step 1: Get the encryption key
  console.log('Decrypting Chrome encryption key...');
  const key = getEncryptionKey();
  console.log(`Key: ${key.length} bytes`);

  // Step 2: Open the Cookies database
  const cookieDbPath = path.join(CHROME_PROFILE_DIR, CHROME_PROFILE, 'Network', 'Cookies');
  if (!fs.existsSync(cookieDbPath)) {
    console.error(`Cookie database not found: ${cookieDbPath}`);
    process.exit(1);
  }

  // Copy to temp file (Chrome may lock the original)
  const tmpDb = path.join(__dirname, 'data', 'cookies-tmp.sqlite');
  fs.copyFileSync(cookieDbPath, tmpDb);

  const db = new Database(tmpDb, { readonly: true });

  // Step 3: Query cookies for ANA domains
  const domainConditions = DOMAINS.map(d => `host_key LIKE '%${d}'`).join(' OR ');
  const rows = db.prepare(`
    SELECT host_key, name, path, encrypted_value, is_secure, is_httponly,
           has_expires, expires_utc, samesite
    FROM cookies
    WHERE ${domainConditions}
    ORDER BY host_key, name
  `).all();

  console.log(`Found ${rows.length} ANA cookies\n`);

  // Step 4: Decrypt and convert to Puppeteer format
  const cookies = [];
  for (const row of rows) {
    const value = decryptCookieValue(row.encrypted_value, key);
    if (value.startsWith('[DECRYPT_FAILED')) {
      console.log(`  ⚠️  ${row.name}: ${value}`);
      continue;
    }
    if (!value && row.name !== 'asw_uuid') continue;

    // Chrome stores expires_utc as microseconds since 1601-01-01
    // Convert to Unix seconds
    let expires = -1;
    if (row.has_expires && row.expires_utc > 0) {
      expires = Math.floor((row.expires_utc / 1000000) - 11644473600);
    }

    // sameSite: 0=None (or unset), 1=Lax, 2=Strict
    const sameSiteMap = { 0: 'None', 1: 'Lax', 2: 'Strict', '-1': 'None' };

    cookies.push({
      name: row.name,
      value,
      domain: row.host_key,
      path: row.path,
      secure: !!row.is_secure,
      httpOnly: !!row.is_httponly,
      sameSite: sameSiteMap[row.samesite] || 'None',
      expires,
    });
  }

  db.close();
  fs.unlinkSync(tmpDb);

  // Step 5: Save
  fs.mkdirSync(path.dirname(COOKIE_OUTPUT), { recursive: true });
  fs.writeFileSync(COOKIE_OUTPUT, JSON.stringify(cookies, null, 2));

  console.log(`✅ Saved ${cookies.length} cookies to ${COOKIE_OUTPUT}`);
  console.log('\nCookies by domain:');
  const byDomain = {};
  for (const c of cookies) {
    byDomain[c.domain] = (byDomain[c.domain] || 0) + 1;
  }
  for (const [domain, count] of Object.entries(byDomain)) {
    console.log(`  ${domain}: ${count}`);
  }

  // Check for session cookies
  const hasSession = cookies.some(c => c.name === 'JSESSIONID');
  const hasAbck = cookies.some(c => c.name === '_abck');
  const hasPersonal = cookies.some(c => c.name === 'personal');
  console.log(`\nSession indicators: JSESSIONID=${hasSession}, _abck=${hasAbck}, personal=${hasPersonal}`);

  if (!hasPersonal) {
    console.log('\n⚠️  No "personal" cookie found — you may need to log in to ANA in Chrome first.');
  }
}

main();
