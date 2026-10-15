// Derives the addresses from the KMS public key, proves control by signing through KMS, and writes the PUBLIC wallet.json.
//   node derive.mjs            addresses only (offline, reads public-key.pem)
//   node derive.mjs --prove    also signs a message with the HSM key and checks it (needs your gcloud sign-in), then writes wallet.json
import { readFile, writeFile } from 'node:fs/promises'
import { bitcoinAddress, ethereumAddress, pubFromPem } from './src/addresses.mjs'
import { KEY_VERSION, getPublicKeyPem, signDigest } from './src/kms.mjs'
import { checkProof, proveControl } from './src/proof.mjs'
import { compressed } from './src/secp256k1.mjs'

const pemPath = new URL('./public-key.pem', import.meta.url)
const pem = await readFile(pemPath, 'utf8')
const pub = pubFromPem(pem)
const eth = ethereumAddress(pub), btc = bitcoinAddress(pub)
console.log(`Ethereum: ${eth}\nBitcoin:  ${btc}`)
if (!process.argv.includes('--prove')) process.exit(0)

const live = await getPublicKeyPem()
if (pubFromPem(live).x !== pub.x || pubFromPem(live).y !== pub.y) { console.error('FAIL: the saved public key is not the key in Cloud KMS. Nothing written.'); process.exit(1) }
console.log('saved public key = Cloud KMS public key: yes')

const message = `RabbitOS donation wallet proof of control, ${new Date().toISOString().slice(0, 10)}`
const proof = await proveControl(pub, (digest) => signDigest(digest), message)
const again = checkProof(proof, pub)
if (!again.ethOk || !again.btcOk) { console.error('FAIL: the proof did not verify on a second, independent check.', again); process.exit(1) }
console.log('PASS: signed with the HSM key; the signature recovers to the Ethereum address and verifies for the Bitcoin address')

const wallet = {
  version: 1,
  purpose: 'Donations and anchoring for RabbitOS / rabbitsoftware.io. Receive-only on the public pages.',
  key: { service: 'Google Cloud KMS (HSM)', resource: KEY_VERSION, algorithm: 'EC_SIGN_SECP256K1_SHA256', publicKeyCompressed: compressed(pub).toString('hex') },
  ethereum: { address: eth, network: 'Ethereum mainnet (also valid on Ethereum-compatible networks, but send only on Ethereum mainnet)' },
  bitcoin: { address: btc, type: 'native SegWit (P2WPKH, bc1q...)', network: 'Bitcoin mainnet' },
  proof,
}
await writeFile(new URL('./wallet.json', import.meta.url), JSON.stringify(wallet, null, 2) + '\n')
console.log('wrote wallet.json (public data only)')
