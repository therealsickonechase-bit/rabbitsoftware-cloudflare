// Used once by Setup-GcpWitness.ps1: makes a witness key, writes the PRIVATE key to standard output only (the script pipes it straight into Secret Manager, so it never lands on disk
// or on screen) and writes the PUBLIC half to the file named on the command line. Usage: node keygen-to-stdout.mjs <name> <public-file>
import { writeFileSync } from 'node:fs'
import { generateKey } from './witness.mjs'

const [name, publicFile] = process.argv.slice(2)
if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name ?? '') || !publicFile) { console.error('usage: node keygen-to-stdout.mjs <name> <public-file>'); process.exit(2) }
const k = generateKey()
writeFileSync(publicFile, JSON.stringify({ name, publicKey: k.publicKey, keyId: k.keyId }, null, 2) + '\n')
process.stdout.write(k.privateKeyPem)
