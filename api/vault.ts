// api/vault.ts
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const MASTER_PEPPER = process.env.MASTER_PEPPER || 'fallback_secret_pepper_32_bytes_!';

export function deriveUserKey(tgUserId: number): Buffer {
    return crypto.scryptSync(MASTER_PEPPER, tgUserId.toString(), 32);
}

// 1. ENCRYPT (Used when generating/importing)
export function encryptPrivateKey(privateKeyHex: string, tgUserId: number) {
    const key = deriveUserKey(tgUserId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(privateKeyHex, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return { 
        encryptedData: encrypted, 
        iv: iv.toString('hex'), 
        tag: cipher.getAuthTag().toString('hex') 
    };
}

// 2. DECRYPT (Used milliseconds before executing a Jupiter Swap)
export function decryptPrivateKey(encryptedData: string, ivHex: string, tagHex: string, tgUserId: number): string {
    const key = deriveUserKey(tgUserId);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted; // Returns the raw hex string of the private key
}