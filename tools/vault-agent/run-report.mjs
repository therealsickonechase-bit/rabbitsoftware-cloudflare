import { open, rename, unlink } from "node:fs/promises";

export async function persistRunReport(path, report, create = false) {
  const content = JSON.stringify(report, null, 2);
  if (create) {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
