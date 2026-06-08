// api/rpc.ts
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

// Initialize connection to a high-speed node. 
// Fallback to public Devnet/Mainnet if your custom environment variable is not set.
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

/**
 * Fetches the native SOL balance for any valid Base58 public key address
 */
export async function getSolBalance(publicKeyBase58: string): Promise<{ lamports: number; sol: number }> {
    try {
        const pubKey = new PublicKey(publicKeyBase58);
        
        // Fetch raw balance directly from the SVM ledger state
        const lamports = await connection.getBalance(pubKey);
        const sol = lamports / LAMPORTS_PER_SOL;
        
        return { lamports, sol };
    } catch (err) {
        console.error(`[RPC ERROR] Failed to fetch balance for address ${publicKeyBase58}:`, err);
        // Fallback safety to prevent crashing the interface if the RPC is lagging
        return { lamports: 0, sol: 0.00 };
    }
}
