import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map();

for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const input = args.get("--in");
const output = args.get("--out");
const passphrase = args.get("--passphrase") || process.env.SOURCE_FILE_KEY;
const iterations = Number(args.get("--iterations") || 250000);

if (!input || !output || !passphrase) {
  console.error(
    "Usage: npm run encrypt-sources -- --in <plain.json> --out <encrypted.json> --passphrase <key>"
  );
  process.exit(1);
}

const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
const cipher = createCipheriv("aes-256-gcm", key, iv);
const encrypted = Buffer.concat([cipher.update(readFileSync(resolve(input))), cipher.final()]);
const authTag = cipher.getAuthTag();

const envelope = {
  version: 1,
  format: "scraperplayer.encrypted-sources",
  algorithm: "AES-256-GCM",
  kdf: "PBKDF2-SHA256",
  iterations,
  salt: salt.toString("base64"),
  iv: iv.toString("base64"),
  ciphertext: Buffer.concat([encrypted, authTag]).toString("base64"),
};

writeFileSync(resolve(output), `${JSON.stringify(envelope, null, 2)}\n`);
console.log(`Encrypted source file written to ${resolve(output)}`);
