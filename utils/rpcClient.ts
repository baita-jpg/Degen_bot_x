// utils/rpcClient.ts
import { Connection } from '@solana/web3.js';

const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Initialize a shared web3 connection instance with confirmed commitment
export const connection = new Connection(RPC_ENDPOINT, 'confirmed');

interface TelemetryReport {
    latencyMs: number;
    blockheight: number;
    status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
}

/**
 * Runs a performance test against the configured RPC node to calculate response times
 */
export async function runRpcTelemetry(): Promise<TelemetryReport> {
    const startTime = performance.now();
    try {
        const blockheight = await connection.getBlockHeight();
        const latencyMs = parseFloat((performance.now() - startTime).toFixed(0));
        
        let status: 'ONLINE' | 'DEGRADED' | 'OFFLINE' = 'ONLINE';
        if (latencyMs > 450) status = 'DEGRADED'; // Slow block inclusion risk
        
        return {
            latencyMs,
            blockheight,
            status
        };
    } catch (err) {
        return {
            latencyMs: 9999,
            blockheight: 0,
            status: 'OFFLINE'
        };
    }
}