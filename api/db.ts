// api/db.ts
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Initialize database handler client
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false } // Crucial configuration flag for serverless stateless workflows
});

/**
 * Syncs the current user session data into the database state on /start
 */
export async function syncUserSession(id: number, username: string | undefined): Promise<void> {
    await supabase.from('users').upsert({ id, username: username || 'unknown' });
}

/**
 * Saves a new encrypted wallet entry and marks previous ones as inactive
 */
export async function saveEncryptedWallet(
    tgUserId: number, 
    publicKey: string, 
    encryptedData: string, 
    iv: string, 
    tag: string
): Promise<void> {
    // 1. Mark existing user wallets as inactive to prevent routing dual-execution errors
    await supabase.from('user_wallets').update({ is_active: false }).eq('tg_user_id', tgUserId);
    
    // 2. Commit the fresh encrypted vault asset records
    const { error } = await supabase.from('user_wallets').insert({
        tg_user_id: tgUserId,
        public_key: publicKey,
        encrypted_secret_payload: encryptedData,
        iv,
        tag,
        is_active: true
    });

    if (error) throw new Error(`Database commit error: ${error.message}`);
}

/**
 * Pulls the primary active execution key data card for an operator
 */
export async function getActiveWallet(tgUserId: number): Promise<any | null> {
    const { data, error } = await supabase
        .from('user_wallets')
        .select('*')
        .eq('tg_user_id', tgUserId)
        .eq('is_active', true)
        .maybeSingle();
        
    if (error) return null;
    return data;
}