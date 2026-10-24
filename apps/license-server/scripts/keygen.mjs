import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

console.log('LICENSE_PRIVATE_KEY (keep secret, store in a KMS/secret manager):');
console.log(privatePem);
console.log('REVLYRA_LICENSE_PUBLIC_KEY (configure on every Revlyra deployment):');
console.log(publicPem);
