const format = "rabbitsoftware.recovered-encrypted-record.v1";
const iterations = 600000;
const maxBytes = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function checkPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024) {
    throw new Error("Use a passphrase between 12 and 1024 characters.");
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("Local encryption requires a secure browser context (HTTPS or localhost).");
  }
}

function encode(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

function decode(value, expectedLength) {
  if (typeof value !== "string" || value.length > Math.ceil((maxBytes + 16) / 3) * 4 ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid encrypted record encoding.");
  }
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (encode(bytes) !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
    throw new Error("Invalid encrypted record field length or encoding.");
  }
  return bytes;
}

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

function validateRecord(record) {
  if (!record || record.schema !== "rabbitsoftware.local-research-record.v1" ||
      record.classification !== "private" || record.chain_published !== false ||
      record.training_shared !== false || !Array.isArray(record.attempts)) {
    throw new Error("Unsupported private research record content.");
  }
}

export async function encryptRecord(record, passphrase) {
  checkPassphrase(passphrase);
  validateRecord(record);
  const plain = encoder.encode(JSON.stringify(record));
  if (plain.length > maxBytes) throw new Error("The research record exceeds the 2 MiB limit.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(format), tagLength: 128 }, key, plain
  );
  return {
    format, cipher: "AES-256-GCM",
    kdf: { name: "PBKDF2-SHA256", iterations, salt: encode(salt) },
    iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted))
  };
}

export async function decryptRecord(envelope, passphrase) {
  checkPassphrase(passphrase);
  if (!envelope || envelope.format !== format) {
    throw new Error("Unsupported format. This recovered website opens only its new recovery-format records, not older records or .dvault files.");
  }
  if (envelope.cipher !== "AES-256-GCM" || envelope.kdf?.name !== "PBKDF2-SHA256" ||
      envelope.kdf.iterations !== iterations) {
    throw new Error("Unsupported encrypted record parameters.");
  }
  const salt = decode(envelope.kdf.salt, 16);
  const iv = decode(envelope.iv, 12);
  const ciphertext = decode(envelope.ciphertext);
  if (ciphertext.length < 16 || ciphertext.length > maxBytes + 16) {
    throw new Error("Invalid encrypted record size.");
  }
  const key = await deriveKey(passphrase, salt);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(format), tagLength: 128 }, key, ciphertext
    );
  } catch (error) {
    if (error.name === "OperationError") {
      throw new Error("Could not open the record: incorrect passphrase or damaged encrypted data.");
    }
    throw error;
  }
  const record = JSON.parse(decoder.decode(plain));
  validateRecord(record);
  return record;
}
