// utils/vault.ts
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const MASTER_PEPPER = process.env.MASTER_PEPPER || 'fallback_secret_pepper_32_bytes_minimum_string_!';

/**
 * Deterministically derives a unique 32-byte cryptographic key per user
 * utilizing the user's Telegram ID as a salt.
 */
function deriveUserKey(tgUserId: number): Buffer {
    return crypto.scryptSync(MASTER_PEPPER, tgUserId.toString(), 32);
}

interface EncryptionResult {
    encryptedData: string;
    iv: string;
    tag: string;
}

/**
 * Encrypts a raw private key string using aes-256-gcm
 */
export function encryptPrivateKey(privateKey: string, tgUserId: number): EncryptionResult {
    const key = deriveUserKey(tgUserId);
    const iv = crypto.randomBytes(12); // GCM standard IV size
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag().toString('hex');
    
    return {
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        tag
    };
}

/**
 * Decrypts an aes-256-gcm encrypted payload back to a raw string string
 */
export function decryptPrivateKey(encryptedData: string, ivHex: string, tagHex: string, tgUserId: number): string {
    const key = deriveUserKey(tgUserId);
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
}