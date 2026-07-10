import { createHash, randomBytes } from 'crypto'

const b64url = (b: Buffer): string => b.toString('base64url')

export function generatePkce(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}
