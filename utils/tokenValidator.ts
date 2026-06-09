// utils/tokenValidator.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

export interface CryptoAuditResult {
    passed: boolean;
    mintAuthorityRevoked: boolean;
    freezeAuthorityRevoked: boolean;
    supply: number;
    decimals: number;
    hazardFlags: string[];
}

/**
 * Directly queries the Solana blockchain to decode the SPL Mint Account.
 * Verifies if the deployer can print infinite tokens or freeze wallets.
 */
export async function runCryptographicAudit(mintAddress: string): Promise<CryptoAuditResult> {
    const hazardFlags: string[] = [];
    let passed = true;

    try {
        const mintPubKey = new PublicKey(mintAddress);
        const mintInfo = await getMint(connection, mintPubKey);

        const mintAuthorityRevoked = mintInfo.mintAuthority === null;
        const freezeAuthorityRevoked = mintInfo.freezeAuthority === null;

        if (!mintAuthorityRevoked) {
            hazardFlags.push("CRITICAL HAZARD: Mint Authority is active. Deployer can inflate supply infinitely.");
            passed = false;
        }

        if (!freezeAuthorityRevoked) {
            hazardFlags.push("CRITICAL HAZARD: Freeze Authority is active. Deployer can honeypot your wallet.");
            passed = false;
        }

        return {
            passed,
            mintAuthorityRevoked,
            freezeAuthorityRevoked,
            supply: Number(mintInfo.supply),
            decimals: mintInfo.decimals,
            hazardFlags
        };

    } catch (err: any) {
        console.error(`Audit Failure for ${mintAddress}:`, err.message);
        return {
            passed: false,
            mintAuthorityRevoked: false,
            freezeAuthorityRevoked: false,
            supply: 0,
            decimals: 0,
            hazardFlags: ["FATAL: Unable to decode on-chain token state. Possible invalid SPL token."]
        };
    }
}