// Prints the Ethereum and XRP Ledger addresses of the ANCHORING key (not the donation wallet) from its public key. Public data only.
//   node derive-anchor.mjs            reads anchor-public-key.pem next to this file
import { readFile } from 'node:fs/promises'
import { ethereumAddress, pubFromPem } from './src/addresses.mjs'
import { xrplAddress } from './src/xrpl.mjs'

const pub = pubFromPem(await readFile(new URL('./anchor-public-key.pem', import.meta.url), 'utf8'))
console.log(JSON.stringify({ ethereum: ethereumAddress(pub), xrpl: xrplAddress(pub) }, null, 2))
