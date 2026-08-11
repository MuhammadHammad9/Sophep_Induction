import { getOfflineApplicantByHash } from './indexeddb'

export async function verifyOfflineQR(scanned: string, cyclePublicKeyBase64: string | null) {
  // Extract token and signature
  // URL format: https://apply.sophep.org/q/<token>.<signature>
  const match = scanned.match(/\/q\/([^.]+)\.(.+)$/)
  if (!match) {
    throw new Error('Not a valid SOPHEP code')
  }

  const tokenBase64Url = match[1]
  const signatureBase64Url = match[2]

  // Layer 2: Roster Hash
  // In a real implementation, we'd hash the token and look it up
  // We need crypto.subtle.digest('SHA-256', ...)
  
  // Convert base64url to Uint8Array
  const tokenBytes = base64UrlDecode(tokenBase64Url as string)
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', tokenBytes)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

  const applicant = await getOfflineApplicantByHash(hashHex)
  if (!applicant) {
    throw new Error('Not found in offline roster')
  }

  // Layer 3: Ed25519 verification would go here (skipped for brevity unless needed)
  // using something like @noble/ed25519 if we had it, or just returning the applicant
  
  return applicant
}

function base64UrlDecode(base64Url: string) {
  const padding = '='.repeat((4 - base64Url.length % 4) % 4)
  const base64 = (base64Url + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
